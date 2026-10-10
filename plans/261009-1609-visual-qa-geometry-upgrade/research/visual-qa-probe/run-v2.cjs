// Throwaway harness: scan-v2 prototype vs current engine on fixtures (375 + 1440) and,
// with --live, on public Haravan storefronts (home + first product + first collection).
const { app, BrowserWindow } = require('electron');
const fs = require('node:fs');
const path = require('node:path');
const { LayoutIntegrityEngine } = require('./engines/integrity.js');
const fixtures = require('./fixtures.cjs');

const LIVE = process.argv.includes('--live');
const ONLY = (process.argv.find((a) => a.startsWith('--only=')) || '').slice(7);
const OUT = path.join(__dirname, LIVE ? 'out-v2-live' : 'out-v2');
fs.mkdirSync(OUT, { recursive: true });
// --no-exempt ablates the read-more, x-scroller and running-animation exemptions to prove
// controls 17/18/19 discriminate.
const V2 = process.argv.includes('--no-exempt')
  ? fs.readFileSync(path.join(__dirname, 'scan-v2.js'), 'utf8')
      .replace('if (a.scrollHeight <= a.clientHeight + 1) return false;', 'return false;')
      .replace('!inXScroller && ', '')
      .replace("if (a.playState === 'running' && a.effect && a.effect.target) animTargets.add(a.effect.target);", '')
  : fs.readFileSync(path.join(__dirname, 'scan-v2.js'), 'utf8');
const VIEWPORTS = [
  { name: 'mobile', width: 375, height: 667, deviceScaleFactor: 2, mobile: true },
  { name: 'desktop', width: 1440, height: 900, deviceScaleFactor: 1, mobile: false },
];
// Kinds that count as "caught" for each defect fixture; [] marks a false-positive control.
const EXPECT = {
  '02': ['clipping'], '03': ['clipping'], '04': ['overlap', 'occlusion'], '05': ['overlap', 'occlusion'],
  '06': ['overlap', 'occlusion'], '07': ['overlap', 'occlusion'], '08': ['clipping'], '09': ['occlusion'],
  '10': ['occlusion'], '11': ['sticky-obstruction', 'occlusion'], '12': [], '13a': ['overlap', 'occlusion'],
  '13b': ['overlap', 'occlusion'], '14': ['layout-shift'], '15': ['occlusion', 'overlap'], '16': [], '17': [], '18': [], '19': [],
};
// Fixtures whose defect is box-level only (no text or control is hidden): a warning is the right call.
// 06: block B's negative margin covers the empty bottom of block A; screenshot shows no text collision.
const WARN_OK = new Set(['06', '14']);
const SITES = [
  ['phukienmaymoc', 'https://phukienmaymoc.com/'],
  ['gixjewel', 'https://gixjewel.com/'],
  ['hapas', 'https://hapas.vn/'],
  ['unitedvision', 'https://www.unitedvision.com.vn/'],
];
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

app.setPath('userData', fs.mkdtempSync(path.join(require('node:os').tmpdir(), 'vqa-v2-')));
app.commandLine.appendSwitch('no-sandbox');
app.commandLine.appendSwitch('disable-features', 'CalculateNativeWinOcclusion');
app.commandLine.appendSwitch('disable-backgrounding-occluded-windows');
app.commandLine.appendSwitch('disable-renderer-backgrounding');
app.on('window-all-closed', () => {});
process.on('unhandledRejection', (e) => { console.error('UNHANDLED', e); process.exit(9); });

async function openAt(vp) {
  const win = new BrowserWindow({ show: false, x: -4000, y: 0, useContentSize: true, width: vp.width, height: vp.height, skipTaskbar: true, focusable: false, webPreferences: { backgroundThrottling: false } });
  win.showInactive();
  await win.loadURL('data:text/html,<p>boot</p>');
  const dbg = win.webContents.debugger;
  dbg.attach('1.3');
  await dbg.sendCommand('Emulation.setDeviceMetricsOverride', vp);
  // An offscreen hidden window paints no frames, so no layout-shift entries exist; a screencast forces frames.
  await dbg.sendCommand('Page.enable');
  dbg.on('message', (_e, method, params) => {
    if (method === 'Page.screencastFrame') dbg.sendCommand('Page.screencastFrameAck', { sessionId: params.sessionId }).catch(() => {});
  });
  await dbg.sendCommand('Page.startScreencast', { format: 'jpeg', quality: 10, everyNthFrame: 1 });
  return { win, dbg, wc: win.webContents };
}

async function scan(wc, vpName) {
  const before = await wc.executeJavaScript('[window.scrollX, window.scrollY]');
  const t0 = Date.now();
  const v2 = await wc.executeJavaScript(V2.replace('__VIEWPORT_NAME__', vpName));
  const wallMs = Date.now() - t0;
  const after = await wc.executeJavaScript('[window.scrollX, window.scrollY]');
  const v1 = await wc.executeJavaScript(LayoutIntegrityEngine.getBrowserScanScript(vpName));
  return {
    v2, wallMs, scrollRestored: before[0] === after[0] && Math.abs(before[1] - after[1]) <= 1,
    v1crit: v1.findings.filter((f) => f.severity === 'critical').map((f) => f.kind + ': ' + f.details),
  };
}

async function clipShots(dbg, id, findings) {
  const crit = findings.filter((f) => f.severity === 'critical' && f.rect).slice(0, 4);
  for (let i = 0; i < crit.length; i++) {
    const r = crit[i].rect;
    const pad = 40;
    const clip = { x: Math.max(0, r.x - pad), y: Math.max(0, r.y - pad), width: Math.max(40, r.w + pad * 2), height: Math.max(40, Math.min(600, r.h + pad * 2)), scale: 1 };
    try {
      const shot = await dbg.sendCommand('Page.captureScreenshot', { format: 'png', clip, captureBeyondViewport: true });
      fs.writeFileSync(path.join(OUT, id + '-crit' + i + '.png'), Buffer.from(shot.data, 'base64'));
    } catch (e) {
      console.log('   shot failed', e.message);
    }
  }
}

const fmt = (fs_) => fs_.map((f) => '      ' + f.severity[0].toUpperCase() + ' ' + f.kind + ': ' + f.details).join('\n');

async function runFixtures() {
  const rows = [];
  for (const vp of VIEWPORTS) {
    for (const fx of fixtures) {
      if (ONLY && !fx.id.startsWith(ONLY)) continue;
      const { win, dbg, wc } = await openAt(vp);
      const file = path.join(OUT, fx.id + '.html');
      fs.writeFileSync(file, fx.html);
      await win.loadFile(file);
      await sleep(fx.settleMs || 600);
      if (fx.id.startsWith('14')) console.log('   truth', JSON.stringify(await wc.executeJavaScript("(() => { const o = new PerformanceObserver(() => {}); o.observe({ type: 'layout-shift', buffered: true }); const r = o.takeRecords(); o.disconnect(); return { truth: window.__truth, entries: r.map((e) => ({ v: e.value, input: e.hadRecentInput, t: Math.round(e.startTime), last: Math.round(e.lastInputTime) })) }; })()")));
      const res = await scan(wc, vp.name);
      const key = fx.id.slice(0, fx.id.indexOf('-'));
      const expect = EXPECT[key];
      const crit = res.v2.findings.filter((f) => f.severity === 'critical');
      let status = 'info';
      if (expect && expect.length === 0) status = crit.length === 0 ? 'OK-control' : 'FALSE-POSITIVE';
      else if (expect && vp.name === 'mobile') {
        const hit = res.v2.findings.some((f) => expect.includes(f.kind) && (f.severity === 'critical' || WARN_OK.has(key)));
        status = hit ? 'CAUGHT' : 'MISSED';
      }
      rows.push({ id: fx.id, vp: vp.name, status, ms: res.v2.stats && res.v2.stats.durationMs, scrollRestored: res.scrollRestored, v1crit: res.v1crit.length, findings: res.v2.findings, stats: res.v2.stats });
      console.log(`${vp.name.padEnd(7)} ${fx.id.padEnd(34)} ${status.padEnd(14)} crit=${crit.length} warn=${res.v2.findings.length - crit.length} v1crit=${res.v1crit.length} ${res.v2.stats ? res.v2.stats.durationMs : '?'}ms restored=${res.scrollRestored}`);
      if (res.v2.findings.length) console.log(fmt(res.v2.findings));
      dbg.detach();
      win.destroy();
    }
  }
  fs.writeFileSync(path.join(OUT, 'results.json'), JSON.stringify(rows, null, 2));
  const mob = rows.filter((r) => r.vp === 'mobile');
  console.log('\nSUMMARY mobile caught=' + mob.filter((r) => r.status === 'CAUGHT').length + ' missed=' + mob.filter((r) => r.status === 'MISSED').map((r) => r.id).join(',') + ' | FP=' + rows.filter((r) => r.status === 'FALSE-POSITIVE').map((r) => r.vp + ':' + r.id).join(',') + ' | unrestored=' + rows.filter((r) => !r.scrollRestored).length);
}

const DISCOVER = `(() => {
  const pick = (re) => { const a = Array.from(document.querySelectorAll('a[href]')).find((x) => re.test(new URL(x.href, location.href).pathname) && new URL(x.href, location.href).host === location.host); return a ? a.href : null; };
  return { product: pick(/^\\/products\\/[^/]+\\/?$/), collection: pick(/^\\/collections\\/[^/]+\\/?$/) };
})()`;

async function runLive() {
  const rows = [];
  for (const [site, home] of SITES) {
    if (ONLY && site !== ONLY) continue;
    const targets = [['home', home]];
    for (const vp of VIEWPORTS) {
      for (const [page, url] of targets) {
        const id = site + '-' + page + '-' + vp.name;
        const { win, dbg, wc } = await openAt(vp);
        try { await win.loadURL(url); } catch (e) { console.log(id, 'load error', e.message); }
        await sleep(5000);
        if (page === 'home' && vp.name === 'mobile') {
          const found = await wc.executeJavaScript(DISCOVER);
          if (found.product) targets.push(['product', found.product]);
          if (found.collection) targets.push(['collection', found.collection]);
        }
        const res = await scan(wc, vp.name);
        const crit = res.v2.findings.filter((f) => f.severity === 'critical');
        rows.push({ id, url: wc.getURL(), stats: res.v2.stats, scrollRestored: res.scrollRestored, v1crit: res.v1crit, findings: res.v2.findings });
        console.log(`\n## ${id} ${wc.getURL()}\n   v2 crit=${crit.length} warn=${res.v2.findings.length - crit.length} v1crit=${res.v1crit.length} ${JSON.stringify(res.v2.stats)} wall=${res.wallMs}ms restored=${res.scrollRestored}`);
        if (res.v2.findings.length) console.log(fmt(res.v2.findings));
        if (crit.length) await clipShots(dbg, id, crit);
        dbg.detach();
        win.destroy();
      }
    }
  }
  fs.writeFileSync(path.join(OUT, 'results.json'), JSON.stringify(rows, null, 2));
  console.log('\nSUMMARY live pages=' + rows.length + ' withCritical=' + rows.filter((r) => r.findings.some((f) => f.severity === 'critical')).map((r) => r.id).join(',') + ' unrestored=' + rows.filter((r) => !r.scrollRestored).length + ' maxMs=' + Math.max(...rows.map((r) => (r.stats ? r.stats.durationMs : 0))));
}

app.whenReady().then(async () => {
  if (LIVE) await runLive();
  else await runFixtures();
  app.quit();
});
