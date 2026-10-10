const { app, BrowserWindow } = require('electron');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const esbuild = require('esbuild');

const root = path.resolve(__dirname, '../..');
const only = (process.argv.find((arg) => arg.startsWith('--only=')) || '').slice(7);
const requestedOut = (process.argv.find((arg) => arg.startsWith('--out=')) || '').slice(6);
const outDir = requestedOut ? path.resolve(requestedOut) : fs.mkdtempSync(path.join(os.tmpdir(), 'antifan-visual-qa-'));
const scanFile = (process.argv.find((arg) => arg.startsWith('--scan-file=')) || '').slice(12);
const corpusArg = (process.argv.find((arg) => arg.startsWith('--corpus=')) || '').slice(9);
const corpusPath = corpusArg ? path.resolve(process.cwd(), corpusArg) : path.join(root, 'test/fixtures/visual-qa/fixtures.cjs');
const viewports = [
  { name: 'mobile', width: 375, height: 667, deviceScaleFactor: 2, mobile: true },
  { name: 'desktop', width: 1440, height: 900, deviceScaleFactor: 1, mobile: false },
];
let currentWin;
let currentDebugger;
let exitCode = 2;

const userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'antifan-visual-qa-userdata-'));
const bundleDir = fs.mkdtempSync(path.join(os.tmpdir(), 'antifan-visual-qa-esbuild-'));
app.setPath('userData', userDataDir);
// Chromium holds userData open until the browser process is gone, so no in-process delete
// succeeds on Windows (EPERM even at will-quit). A detached reaper waits for this pid to
// exit, then removes the run's scratch dirs; outDir stays because SUMMARY points at it.
const REAPER = `const fs = require('node:fs');
const [pid, ...dirs] = process.argv.slice(1);
const alive = () => { try { process.kill(Number(pid), 0); return true; } catch (error) { return error.code === 'EPERM'; } };
const deadline = Date.now() + 30 * 60 * 1000;
const tick = () => {
  if (!alive()) { for (const dir of dirs) { try { fs.rmSync(dir, { recursive: true, force: true, maxRetries: 20, retryDelay: 250 }); } catch {} } return; }
  if (Date.now() < deadline) setTimeout(tick, 250);
};
tick();`;
require('node:child_process').spawn(process.execPath, ['-e', REAPER, String(process.pid), userDataDir, bundleDir], {
  detached: true, stdio: 'ignore', windowsHide: true, env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' },
}).unref();
app.commandLine.appendSwitch('no-sandbox');
app.commandLine.appendSwitch('disable-features', 'CalculateNativeWinOcclusion');
app.commandLine.appendSwitch('disable-backgrounding-occluded-windows');
app.commandLine.appendSwitch('disable-renderer-backgrounding');
app.on('window-all-closed', () => {});
process.on('unhandledRejection', fail);
process.on('uncaughtException', fail);

function fail(error) {
  console.error(error && error.stack ? error.stack : error);
  exitCode = 2;
  app.exit(exitCode);
}
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function openAt(vp) {
  const win = new BrowserWindow({
    show: false, x: -4000, y: 0, useContentSize: true,
    width: vp.width, height: vp.height, skipTaskbar: true, focusable: false,
    webPreferences: { backgroundThrottling: false },
  });
  win.showInactive();
  await win.loadURL('data:text/html,<p>boot</p>');
  const dbg = win.webContents.debugger;
  dbg.attach('1.3');
  await dbg.sendCommand('Emulation.setDeviceMetricsOverride', vp);
  await dbg.sendCommand('Page.enable');
  dbg.on('message', (_event, method, params) => {
    if (method === 'Page.screencastFrame') {
      dbg.sendCommand('Page.screencastFrameAck', { sessionId: params.sessionId }).catch(() => {});
    }
  });
  await dbg.sendCommand('Page.startScreencast', { format: 'jpeg', quality: 10, everyNthFrame: 1 });
  currentWin = win;
  currentDebugger = dbg;
  return win;
}

function scanScript(integrity, viewportName) {
  if (scanFile) {
    return fs.readFileSync(path.resolve(scanFile), 'utf8').replace("'__VIEWPORT_NAME__'", () => JSON.stringify(viewportName));
  }
  return integrity.getBrowserScanScript(viewportName);
}
function inspectObject(value, label) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error(`${label} scan returned a non-object`);
  return value;
}
// Each entry needs a non-empty id and html, and exactly one verdict rule in expect.
// A defect rule (kinds or documentOverflow) is asserted on expect.viewports (default mobile);
// its other viewports are reported as info, never counted as passes. A control is asserted on
// every viewport: no critical, no warning unless allowWarning, no document overflow unless allowOverflow.
function loadCorpus(file) {
  const corpus = require(file);
  if (!Array.isArray(corpus) || !corpus.length) throw new Error(`Corpus ${file} must export a non-empty array`);
  const names = viewports.map((vp) => vp.name);
  const invalid = corpus.filter((entry) => {
    const expect = entry && entry.expect;
    const rules = [expect && expect.kinds, expect && expect.control, expect && expect.documentOverflow].filter(Boolean).length;
    const scoped = expect && expect.viewports !== undefined;
    const badScope = scoped && (expect.control || !Array.isArray(expect.viewports) || !expect.viewports.length
      || expect.viewports.some((name) => !names.includes(name)));
    return !entry || !entry.id || !entry.html || rules !== 1 || badScope;
  });
  if (invalid.length) throw new Error(`Corpus entries break the contract: ${invalid.map((entry) => (entry && entry.id) || '(no id)').join(', ')}`);
  return corpus;
}

async function run() {
  fs.mkdirSync(outDir, { recursive: true });
  const integrityEntry = path.join(root, 'src/main/qa/scanners/layout-integrity-engine.ts');
  const overflowEntry = path.join(root, 'src/main/qa/scanners/layout-overflow-engine.ts');
  esbuild.buildSync({
    entryPoints: { integrity: integrityEntry, overflow: overflowEntry },
    bundle: true, format: 'cjs', platform: 'node', outdir: bundleDir, logLevel: 'error',
  });
  const { LayoutIntegrityEngine } = require(path.join(bundleDir, 'integrity.js'));
  const { LayoutOverflowEngine } = require(path.join(bundleDir, 'overflow.js'));
  const selected = loadCorpus(corpusPath).filter((fixture) => !only || fixture.id.startsWith(only));
  if (!selected.length) throw new Error(`No fixture matches --only=${only}`);
  const rows = [];
  for (const vp of viewports) {
    for (const fixture of selected) {
      const htmlPath = path.join(outDir, `${vp.name}-${fixture.id}.html`);
      fs.writeFileSync(htmlPath, fixture.html, 'utf8');
      const win = await openAt(vp);
      const wc = win.webContents;
      await wc.loadFile(htmlPath);
      await sleep(fixture.settleMs || 600);
      // Window and body scroll offsets: a page whose body is the scroller keeps its position there.
      const SCROLL_STATE = '[window.scrollX, window.scrollY, document.body.scrollLeft, document.body.scrollTop]';
      const before = await wc.executeJavaScript(SCROLL_STATE);
      const started = Date.now();
      const integrity = inspectObject(await wc.executeJavaScript(scanScript(LayoutIntegrityEngine, vp.name)), 'integrity');
      const wallMs = Date.now() - started;
      const after = await wc.executeJavaScript(SCROLL_STATE);
      const overflow = inspectObject(await wc.executeJavaScript(LayoutOverflowEngine.getBrowserScanScript(vp.name)), 'overflow');
      const restored = before[0] === after[0] && before.every((value, i) => Math.abs(value - after[i]) <= 1);
      const crit = Array.isArray(integrity.findings) ? integrity.findings.filter((finding) => finding.severity === 'critical').length : 0;
      const warn = Array.isArray(integrity.findings) ? integrity.findings.filter((finding) => finding.severity === 'warning').length : 0;
      const reasons = [];
      if (integrity.measured !== true) reasons.push('integrity scan did not report measured=true');
      if (!restored) reasons.push(`scroll not restored (${before.join(',')} → ${after.join(',')})`);
      if (wallMs > 3000) reasons.push(`scan wall time ${wallMs}ms exceeds 3000ms`);
      // A truncated scan or a detector that threw is an evidence gap, never a pass or a catch.
      const stats = integrity.stats || {};
      if (stats.truncated === true) reasons.push(`scan truncated: ${(stats.truncatedReasons || []).join('; ') || 'no reason reported'}`);
      if (Array.isArray(stats.failedDetectors) && stats.failedDetectors.length) reasons.push(`detectors failed: ${[...new Set(stats.failedDetectors)].join(', ')}`);
      const expect = fixture.expect;
      const asserted = expect.control || (expect.viewports || ['mobile']).includes(vp.name);
      if (expect.kinds && asserted) {
        const caught = integrity.findings.some((finding) => expect.kinds.includes(finding.kind) && (finding.severity === 'critical' || expect.allowWarning));
        if (!caught) reasons.push(`expected one of ${expect.kinds.join('|')} at ${vp.name}`);
      } else if (expect.documentOverflow && asserted && overflow.hasOverflow !== true) {
        reasons.push(`expected overflow.hasOverflow === true at ${vp.name}`);
      } else if (expect.control) {
        if (crit !== 0) reasons.push(`control has ${crit} critical finding(s)`);
        if (warn !== 0 && !expect.allowWarning) reasons.push(`control has ${warn} warning finding(s)`);
        if (overflow.measured !== true) reasons.push('overflow scan did not report measured=true');
        else if (overflow.hasOverflow !== false && !expect.allowOverflow) reasons.push(`control has document overflow (deltaX=${overflow.deltaX})`);
      }
      const status = reasons.length ? 'FAIL' : asserted ? 'PASS' : 'info';
      const row = { vp: vp.name, id: fixture.id, status, wallMs, restored, reasons, integrity, overflow };
      rows.push(row);
      console.log(`${vp.name} ${fixture.id} ${status} crit=${crit} warn=${warn} ms=${integrity.stats?.durationMs ?? '-'} wall=${wallMs} restored=${restored}`);
      if (status === 'FAIL') {
        for (const reason of reasons) console.log(`    ${reason}`);
        for (const finding of integrity.findings || []) {
          console.log(`    ${finding.severity[0].toUpperCase()} ${finding.kind}: ${finding.details}`);
        }
      }
      try { currentDebugger.detach(); } catch {}
      win.destroy();
      currentWin = undefined;
      currentDebugger = undefined;
    }
  }
  const failed = rows.filter((row) => row.status === 'FAIL').map((row) => `${row.vp}:${row.id}`);
  const passed = rows.filter((row) => row.status === 'PASS').length;
  const info = rows.filter((row) => row.status === 'info').length;
  fs.writeFileSync(path.join(outDir, 'results.json'), JSON.stringify(rows, null, 2), 'utf8');
  console.log(`SUMMARY pass=${passed} info=${info} fail=${failed.length} failed=${failed.join(',')} out=${outDir}`);
  exitCode = failed.length ? 1 : 0;
}

app.whenReady().then(() => run().then(() => app.exit(exitCode)).catch(fail));
