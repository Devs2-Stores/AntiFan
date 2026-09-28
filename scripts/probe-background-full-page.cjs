/**
 * Standalone Electron OSR capture experiment: does a raw CDP
 * Page.captureScreenshot({fromSurface:true, captureBeyondViewport:true}) produce a
 * complete single-raster full-page PNG on the SAME WebContents that MCP-style
 * actions mutated, without attaching, foregrounding, or reloading?
 *
 * Isolation contract:
 *   - Every case runs in a FRESH Electron process with a mkdtemp userData dir.
 *     Nothing attaches to or probes the user's running AntiFan instance (no
 *     remote-debugging port, no shared profile, no bridge). The supervisor runs
 *     under plain Node and spawns one Electron worker per mode:
 *     `<electron> <this-file> --worker-mode=<mode>`.
 *   - No `fromSurface:false` anywhere: on an OSR target without a native window
 *     that path dereferences a null native handle and kills the browser process
 *     (measured 0xC0000005 in GrabNativeWindowSnapshot, tab-devtools-host.ts).
 *   - No scroll-and-stitch, no re-navigation: one captureScreenshot call per
 *     raster; completeness is proven by image geometry + marker pixels.
 *   - Production code is never imported. Production construction is replicated
 *     inline (security-policy.ts:getSecureWebPreferences with offscreen:true →
 *     offscreen, backgroundThrottling:false, paintWhenInitiallyHidden:false;
 *     preload/partition omitted — app-internal plumbing that does not feed the
 *     raster pipeline).
 *
 * Why one process per mode: OSR BeginFrame state, debugger transport and
 * paintWhenInitiallyHidden are webPreferences-time or renderer-lifetime
 * properties; a wedged CDP queue from case N must not contaminate case N+1.
 *
 * Modes (select with --only=a,b; default all):
 *   wcv-production-blank      WebContentsView, production prefs, about:blank,
 *                             NEVER loadURL'ed — mirrors the bound live tab whose
 *                             Runtime.evaluate timed out at 3000ms.
 *   wcv-simple-blank          Same shape, minimal prefs — isolates prefs vs
 *                             construction as the hang cause.
 *   wcv-production-loaded     Production prefs + real fixture navigation.
 *   wcv-production-painton    Production prefs but paintWhenInitiallyHidden:true
 *                             — tests whether the hidden-paint opt-out is the
 *                             BeginFrame blocker.
 *   wcv-production-attached   Production prefs, view attached to hidden host
 *                             window — tests whether compositor attachment (no
 *                             show/focus) changes OSR rasterization.
 *   wcv-simple-loaded         Minimal offscreen prefs — construction delta.
 *   bw-simple-loaded          Official OSR recipe surface: BrowserWindow
 *                             show:false + webPreferences.offscreen — the
 *                             documented working configuration.
 *   bw-production-loaded      BrowserWindow + production prefs — separates
 *                             surface class from preferences.
 *
 * Run:
 *   node scripts/run-electron.cjs scripts/probe-background-full-page.cjs [--only=a,b]
 *   or directly: <path-to-electron> scripts/probe-background-full-page.cjs
 * Flags: --eval-ms=3000 --capture-ms=15000 --settle-ms=5000 --width=800
 *        --height=600 --worker-timeout-ms=90000 --software
 * Exit: 0 when every selected mode produced a parsed report; per-mode `ok`
 *       fields carry the actual capability verdicts. 1 on harness failure.
 */
'use strict';

const path = require('node:path');
const fs = require('node:fs');
const os = require('node:os');

const electron = require('electron');
const IS_WORKER = process.argv.some((a) => a.startsWith('--worker-mode='));

// ---------------------------------------------------------------------------
// Shared constants
// ---------------------------------------------------------------------------

const FIXTURE = {
  bandCss: 800,                      // px per marker band; doc height = 3 * bandCss
  markerTop: 'rgb(255, 0, 0)',       // baseline top
  markerMiddle: 'rgb(0, 128, 0)',    // baseline middle
  markerFooter: 'rgb(0, 0, 255)',    // footer, never mutated
  mutatedTop: 'rgb(255, 255, 0)',    // injected <style> → top becomes yellow
  mutatedMiddle1: 'rgb(0, 255, 255)',// inline style → middle becomes cyan
  mutatedMiddle2: 'rgb(255, 0, 255)',// second mutation → magenta (proves raster 2 is fresh)
};
const FORM_VALUE = 'unsaved-form-value';
const TOKEN = 'same-document-ckpt';

function buildFixtureHtml() {
  return `<!doctype html><html><head><meta charset="utf-8"><style>
html,body{margin:0;padding:0}
.band{height:${FIXTURE.bandCss}px;width:100%}
#marker-top{background:${FIXTURE.markerTop}}
#marker-middle{background:${FIXTURE.markerMiddle}}
#marker-footer{background:${FIXTURE.markerFooter}}
#note{width:200px;height:24px}
</style></head><body>
<div class="band" id="marker-top"><input id="note" value=""></div>
<div class="band" id="marker-middle"></div>
<div class="band" id="marker-footer"></div>
</body></html>`;
}

const MUTATE_EXPR = `(() => {
  window.__captureToken = ${JSON.stringify(TOKEN)};
  const mid = document.getElementById('marker-middle');
  mid.style.backgroundColor = '${FIXTURE.mutatedMiddle1}';
  mid.setAttribute('data-mutation', 'applied');
  document.getElementById('note').value = ${JSON.stringify(FORM_VALUE)};
  const s = document.createElement('style');
  s.id = 'capture-style-override';
  s.textContent = '#marker-top { background-color: ${FIXTURE.mutatedTop} !important; }';
  document.head.appendChild(s);
  return { ok: true, token: window.__captureToken };
})()`;

const REMUTATE_EXPR = `(() => {
  document.getElementById('marker-middle').style.backgroundColor = '${FIXTURE.mutatedMiddle2}';
  return true;
})()`;

const STATE_EXPR = `(() => ({
  url: location.href,
  note: document.getElementById('note').value,
  token: window.__captureToken || null,
  mutation: document.getElementById('marker-middle').getAttribute('data-mutation'),
  styleOverride: Boolean(document.getElementById('capture-style-override')),
  innerWidth, innerHeight,
  scrollHeight: document.documentElement.scrollHeight,
  scrollY,
}))()`;

// ---------------------------------------------------------------------------
// Supervisor (plain Node): spawn one Electron worker per mode, collect reports
// ---------------------------------------------------------------------------

function parseArgs(argv) {
  const out = {};
  for (const arg of argv) {
    const m = arg.match(/^--([a-z-]+)(?:=(.*))?$/);
    if (m) out[m[1]] = m[2] === undefined ? true : m[2];
  }
  return out;
}

const ALL_MODES = [
  'wcv-production-blank',
  'wcv-production-blank-loadurl',
  'wcv-simple-blank',
  'wcv-production-loaded',
  'wcv-production-painton',
  'wcv-production-attached',
  'wcv-simple-loaded',
  'bw-simple-loaded',
  'bw-production-loaded',
];

function runSupervisor() {
  const { spawn } = require('node:child_process');
  const args = parseArgs(process.argv.slice(2));
  const only = typeof args.only === 'string' ? args.only.split(',').map((s) => s.trim()).filter(Boolean) : null;
  const modes = only ? ALL_MODES.filter((m) => only.includes(m)) : ALL_MODES;
  if (modes.length === 0) {
    console.error(`[probe-bg-fp] no modes selected; valid: ${ALL_MODES.join(', ')}`);
    process.exit(1);
  }
  const workerTimeoutMs = Math.max(10_000, Number(args['worker-timeout-ms']) || 90_000);
  const forward = Object.entries(args)
    .filter(([k]) => ['eval-ms', 'capture-ms', 'settle-ms', 'width', 'height', 'software'].includes(k))
    .map(([k, v]) => (v === true ? `--${k}` : `--${k}=${v}`));

  // Resolve the Electron binary from the local install: under plain Node,
  // require('electron') returns the binary path; under Electron runtime it
  // would be the module — the supervisor never runs there.
  const electronBin = typeof electron === 'string' ? electron : process.execPath;

  console.log(`[probe-bg-fp] supervisor: ${modes.length} mode(s), worker timeout ${workerTimeoutMs}ms, electron=${electronBin}`);
  const reports = [];
  let harnessFailures = 0;

  const runOne = (mode) => new Promise((resolve) => {
    const env = { ...process.env };
    delete env.ELECTRON_RUN_AS_NODE; // same guard as scripts/run-electron.cjs
    const child = spawn(electronBin, [__filename, `--worker-mode=${mode}`, ...forward], {
      stdio: ['ignore', 'pipe', 'pipe'],
      env,
    });
    let out = '';
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      try { child.kill('SIGTERM'); } catch {}
      setTimeout(() => { try { child.kill('SIGKILL'); } catch {} }, 3000).unref();
    }, workerTimeoutMs);
    child.stdout.on('data', (d) => { out += d.toString(); });
    child.stderr.on('data', (d) => { out += d.toString(); });
    child.on('error', (err) => {
      clearTimeout(timer);
      harnessFailures++;
      reports.push({ mode, ok: false, harnessError: String(err && err.message || err) });
      resolve();
    });
    child.on('close', (code, signal) => {
      clearTimeout(timer);
      const line = out.split(/\r?\n/).filter((l) => l.startsWith('PROBE_RESULT ')).pop();
      if (line) {
        try {
          const report = JSON.parse(line.slice('PROBE_RESULT '.length));
          report.mode = mode;
          report.exitCode = code;
          reports.push(report);
          resolve();
          return;
        } catch {}
      }
      harnessFailures++;
      reports.push({
        mode, ok: false,
        harnessError: `no PROBE_RESULT line (exit=${code} signal=${signal}${timedOut ? ' timedOut' : ''})`,
        tail: out.split(/\r?\n/).filter(Boolean).slice(-8),
      });
      resolve();
    });
  });

  (async () => {
    for (const mode of modes) {
      await runOne(mode);
      const r = reports[reports.length - 1];
      const px = (c) => (c && c.px ? `px:${JSON.stringify(c.px)}` : 'no-px');
      const cap = (c) => (c ? (c.ok ? `ok ${c.ms}ms ${c.size && c.size.join('x')} ${px(c)}` : `FAIL ${c.err}`) : 'skipped');
      console.log(`[probe-bg-fp] ${r.mode}: ok=${r.ok}`
        + ` eval=${r.preflight && r.preflight.eval ? (r.preflight.eval.ok ? `${r.preflight.eval.ms}ms` : `FAIL(${r.preflight.eval.err})`) : 'n/a'}`
        + ` vp=${cap(r.baselineViewport)} full1=${cap(r.full1)} full2=${cap(r.full2)}`
        + `${r.error ? ` error=${r.error}` : ''}${r.harnessError ? ` harness=${r.harnessError}` : ''}`);
    }
    console.log('PROBE_REPORTS ' + JSON.stringify({ generatedAt: new Date().toISOString(), reports }));
    const parsed = reports.filter((r) => !r.harnessError).length;
    console.log(`[probe-bg-fp] done: ${parsed}/${modes.length} modes reported, ${harnessFailures} harness failure(s)`);
    process.exit(harnessFailures === 0 ? 0 : 1);
  })();
}

// ---------------------------------------------------------------------------
// Worker (Electron): one surface, one mode, one report line, always cleaned up
// ---------------------------------------------------------------------------

function runWorker(mode) {
  const { app, BrowserWindow, WebContentsView, nativeImage } = electron;
  const http = require('node:http');
  const zlib = require('node:zlib');

  const args = parseArgs(process.argv.slice(2));
  const W = Math.max(64, Number(args.width) || 800);
  const H = Math.max(64, Number(args.height) || 600);
  const EVAL_MS = Math.max(500, Number(args['eval-ms']) || 3000);
  const CAPTURE_MS = Math.max(1000, Number(args['capture-ms']) || 15_000);
  const SETTLE_MS = Math.max(500, Number(args['settle-ms']) || 5000);

  app.commandLine.appendSwitch('no-sandbox');
  if (args.software) app.disableHardwareAcceleration();

  const tempUserData = fs.mkdtempSync(path.join(os.tmpdir(), `antifan-osr-${mode}-`));
  app.setPath('userData', tempUserData);

  const delay = (ms) => new Promise((r) => setTimeout(r, ms));

  /** Resolve to a tagged outcome instead of rejecting; callers get timing + error. */
  function bounded(promise, ms) {
    let timer;
    return Promise.race([
      Promise.resolve(promise).then(
        (v) => ({ outcome: 'ok', value: v }),
        (e) => ({ outcome: 'error', error: String((e && e.message) || e).slice(0, 160) }),
      ).finally(() => clearTimeout(timer)),
      new Promise((resolve) => { timer = setTimeout(() => resolve({ outcome: 'timeout' }), ms); }),
    ]);
  }

  async function sendCdp(wc, method, params, ms) {
    const t0 = Date.now();
    const r = await bounded(wc.debugger.sendCommand(method, params || {}), ms);
    const res = { ms: Date.now() - t0 };
    if (r.outcome === 'ok') { res.ok = true; res.result = r.value; }
    else { res.ok = false; res.err = r.outcome === 'timeout' ? `TIMEOUT(${ms}ms)` : r.error; }
    return res;
  }

  // --- Pixel channel calibration: encode a known RGBA PNG, decode via
  // nativeImage, read toBitmap(), locate the red channel. Removes the
  // "BGRA vs RGBA" guess from every check on this exact runtime.
  function encodePngRgba(width, height, rgba /* Buffer w*h*4 */) {
    const crcTable = [];
    for (let n = 0; n < 256; n++) {
      let c = n;
      for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
      crcTable[n] = c >>> 0;
    }
    const crc32 = (buf) => {
      let c = 0xffffffff;
      for (const b of buf) c = crcTable[(c ^ b) & 0xff] ^ (c >>> 8);
      return (c ^ 0xffffffff) >>> 0;
    };
    const chunk = (type, data) => {
      const len = Buffer.alloc(4); len.writeUInt32BE(data.length);
      const td = Buffer.concat([Buffer.from(type, 'ascii'), data]);
      const crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(td));
      return Buffer.concat([len, td, crc]);
    };
    const ihdr = Buffer.alloc(13);
    ihdr.writeUInt32BE(width, 0); ihdr.writeUInt32BE(height, 4);
    ihdr[8] = 8; ihdr[9] = 6; // 8-bit RGBA
    const raw = Buffer.alloc(height * (1 + width * 4));
    for (let y = 0; y < height; y++) {
      raw[y * (1 + width * 4)] = 0; // filter: none
      rgba.copy(raw, y * (1 + width * 4) + 1, y * width * 4, (y + 1) * width * 4);
    }
    return Buffer.concat([
      Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
      chunk('IHDR', ihdr),
      chunk('IDAT', zlib.deflateSync(raw)),
      chunk('IEND', Buffer.alloc(0)),
    ]);
  }

  function detectBitmapOrder() {
    const knownRed = Buffer.from([255, 0, 0, 255]);
    const png = encodePngRgba(1, 1, knownRed);
    const bitmap = nativeImage.createFromBuffer(png).toBitmap();
    if (bitmap.length < 4) return 'unknown';
    const px = [bitmap[0], bitmap[1], bitmap[2], bitmap[3]];
    if (px[0] === 255 && px[2] === 0) return 'RGBA';
    if (px[2] === 255 && px[0] === 0) return 'BGRA';
    return 'unknown';
  }

  const ORDER = detectBitmapOrder();
  const IDX = ORDER === 'RGBA' ? [0, 1, 2, 3] : ORDER === 'BGRA' ? [2, 1, 0, 3] : null;

  /** Read pixel (x,y) from a decoded capture; returns logical [r,g,b,a] or null. */
  function pixel(img, x, y) {
    const size = img.getSize();
    if (!IDX || x >= size.width || y >= size.height) return null;
    const bmp = img.toBitmap();
    const off = (y * size.width + x) * 4;
    if (off + 3 >= bmp.length) return null;
    return [bmp[off + IDX[0]], bmp[off + IDX[1]], bmp[off + IDX[2]], bmp[off + IDX[3]]];
  }

  const near = (actual, expected, tol = 10) =>
    Array.isArray(actual) && expected.every((v, i) => Math.abs(actual[i] - v) <= tol);

  function productionPrefs(paintWhenInitiallyHidden) {
    // Inline replica of security-policy.ts:getSecureWebPreferences(partition,
    // {offscreen:true, backgroundThrottling:false}) — values only; preload and
    // partition omitted (app-internal path/session plumbing, no raster effect).
    return {
      contextIsolation: true, sandbox: true, nodeIntegration: false,
      webSecurity: true, allowRunningInsecureContent: false,
      navigateOnDragDrop: false, spellcheck: false,
      backgroundThrottling: false,
      autoplayPolicy: 'no-user-gesture-required',
      plugins: true, webgl: true,
      offscreen: true,
      paintWhenInitiallyHidden,
    };
  }

  function buildSurface() {
    // Returns { wc|null, view|null, win|null, construction }.
    switch (mode) {
      case 'wcv-production-blank-loadurl':
      case 'wcv-production-blank':
      case 'wcv-production-loaded':
      case 'wcv-production-attached': {
        const win = new BrowserWindow({ width: W, height: H, show: false });
        const view = new WebContentsView({ webPreferences: productionPrefs(false) });
        view.setBounds({ x: 0, y: 0, width: W, height: H });
        try { view.setBackgroundColor('#ffffff'); } catch {}
        if (mode === 'wcv-production-attached') win.contentView.addChildView(view);
        return { wc: view.webContents, view, win, construction: 'WebContentsView+prod-prefs' + (mode.endsWith('attached') ? '+attached' : mode.endsWith('loadurl') ? '+loadURL-blank' : '') };
      }
      case 'wcv-production-painton': {
        const win = new BrowserWindow({ width: W, height: H, show: false });
        const view = new WebContentsView({ webPreferences: productionPrefs(true) });
        view.setBounds({ x: 0, y: 0, width: W, height: H });
        try { view.setBackgroundColor('#ffffff'); } catch {}
        return { wc: view.webContents, view, win, construction: 'WebContentsView+prod-prefs+paintWhenInitiallyHidden' };
      }
      case 'wcv-simple-blank':
      case 'wcv-simple-loaded': {
        const win = new BrowserWindow({ width: W, height: H, show: false });
        const view = new WebContentsView({ webPreferences: { offscreen: true, backgroundThrottling: false } });
        view.setBounds({ x: 0, y: 0, width: W, height: H });
        try { view.setBackgroundColor('#ffffff'); } catch {}
        return { wc: view.webContents, view, win, construction: 'WebContentsView+minimal-osr-prefs' };
      }
      case 'bw-simple-loaded':
        return {
          wc: null, view: null,
          win: new BrowserWindow({ width: W, height: H, show: false, webPreferences: { offscreen: true, backgroundThrottling: false } }),
          construction: 'BrowserWindow+minimal-osr-prefs',
        };
      case 'bw-production-loaded':
        return {
          wc: null, view: null,
          win: new BrowserWindow({ width: W, height: H, show: false, webPreferences: productionPrefs(false) }),
          construction: 'BrowserWindow+prod-prefs',
        };
      default:
        throw new Error(`unknown worker mode ${mode}`);
    }
  }

  function decodeCapture(cdpResult) {
    const img = nativeImage.createFromBuffer(Buffer.from(cdpResult.data, 'base64'));
    return { img, size: img.getSize() };
  }

  function checkFullRaster(cdpResult, expected) {
    // expected: {top:[r,g,b,a], mid:[...], foot:[...]} in logical RGBA.
    const { img, size } = decodeCapture(cdpResult);
    const bandPx = FIXTURE.bandCss; // scale=1, dsf=1 → device px == css px
    const px = {
      top: pixel(img, Math.floor(size.width / 2), Math.floor(bandPx * 0.5)),
      mid: pixel(img, Math.floor(size.width / 2), Math.floor(bandPx * 1.5)),
      foot: pixel(img, Math.floor(size.width / 2), Math.floor(bandPx * 2.5)),
    };
    const checks = {
      heightComplete: size.height === bandPx * 3 && size.width === W,
      top: near(px.top, expected.top),
      mid: near(px.mid, expected.mid),
      foot: near(px.foot, expected.foot),
    };
    return { size: [size.width, size.height], px, checks, ok: Object.values(checks).every(Boolean) };
  }

  app.whenReady().then(async () => {
    const report = {
      mode,
      engine: { electron: process.versions.electron, chrome: process.versions.chrome, node: process.versions.node, platform: process.platform },
      construction: null,
      pixelOrder: ORDER,
      preflight: {},
      geometry: {},
      state: {},
      baselineViewport: null,
      full1: null,
      full2: null,
      capturePageViewport: null,
      paintEvents: 0,
      ok: false,
    };
    let surface = null;
    let server = null;
    let paintCount = 0;

    try {
      surface = buildSurface();
      const wc = surface.wc || surface.win.webContents;
      report.construction = surface.construction;
      wc.on('paint', () => { paintCount++; });

      try { if (!wc.debugger.isAttached()) wc.debugger.attach('1.3'); } catch (e) {
        report.preflight.attach = { ok: false, err: String(e.message).slice(0, 120) };
      }
      await sendCdp(wc, 'Page.enable', {}, 4000);

      const isBlank = mode.endsWith('-blank') || mode.endsWith('-blank-loadurl');
      if (!isBlank) {
        server = http.createServer((_req, res) => {
          res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
          res.end(buildFixtureHtml());
        });
        await new Promise((r) => server.listen(0, '127.0.0.1', r));
        const url = `http://127.0.0.1:${server.address().port}/`;
        const nav = await bounded(wc.loadURL(url), 15_000);
        report.preflight.loadURL = nav.outcome === 'ok' ? { ok: true } : { ok: false, err: nav.outcome === 'timeout' ? 'TIMEOUT(15000ms)' : nav.error };
        // Deterministic settle: poll for the footer marker, not a fixed sleep.
        let settled = false;
        for (let i = 0; i < Math.ceil(SETTLE_MS / 100); i++) {
          const probe = await sendCdp(wc, 'Runtime.evaluate', { expression: `Boolean(document.getElementById('marker-footer'))`, returnByValue: true }, 2000);
          if (probe.ok && probe.result && probe.result.result && probe.result.result.value === true) { settled = true; break; }
          await delay(100);
        }
        report.preflight.settled = settled;
      } else if (mode.endsWith('-blank-loadurl')) {
        // The proposed fix shape: explicit loadURL('about:blank') on an offscreen
        // WebContentsView — proves whether a renderer document materializes.
        const nav = await bounded(wc.loadURL('about:blank'), 15_000);
        report.preflight.loadURL = nav.outcome === 'ok' ? { ok: true } : { ok: false, err: nav.outcome === 'timeout' ? 'TIMEOUT(15000ms)' : nav.error };
        report.preflight.url = wc.getURL();
        report.preflight.isLoading = wc.isLoading();
      } else {
        // about:blank tab: nothing loaded — the exact shape of the bound live tab
        // whose Runtime.evaluate timed out. No loadURL anywhere in this case.
        await delay(400);
        report.preflight.url = wc.getURL();
        report.preflight.isLoading = wc.isLoading();
      }

      // Transport-vs-raster separation: prove a cheap command answers before any
      // screenshot is attempted (mirrors the live 3000ms eval timeout).
      report.preflight.eval = await sendCdp(wc, 'Runtime.evaluate', { expression: '({href:location.href,ready:document.readyState})', returnByValue: true }, EVAL_MS);
      if (report.preflight.eval.ok) report.preflight.eval.value = report.preflight.eval.result && report.preflight.eval.result.result && report.preflight.eval.result.result.value;
      delete report.preflight.eval.result;
      report.preflight.metrics = await sendCdp(wc, 'Page.getLayoutMetrics', {}, 4000);
      if (report.preflight.metrics.ok && report.preflight.metrics.result) {
        const m = report.preflight.metrics.result;
        report.geometry.metrics = {
          cssContentSize: m.cssContentSize && [m.cssContentSize.width, m.cssContentSize.height],
          cssLayoutViewport: m.cssLayoutViewport && [m.cssLayoutViewport.clientWidth, m.cssLayoutViewport.clientHeight],
        };
      }
      delete report.preflight.metrics.result;
      if (surface.view) report.geometry.viewBounds = surface.view.getBounds();
      if (surface.win) report.geometry.windowShown = surface.win.isVisible();

      const captureParams = (beyond, clip) => ({ format: 'png', fromSurface: true, captureBeyondViewport: beyond, clip });

      if (isBlank) {
        const r = await sendCdp(wc, 'Page.captureScreenshot', captureParams(false), CAPTURE_MS);
        report.baselineViewport = r.ok ? { ok: true, ms: r.ms, ...(() => { const { size } = decodeCapture(r.result); return { size: [size.width, size.height] }; })() } : { ok: false, ms: r.ms, err: r.err };
      } else {
        // Baseline viewport raster, pre-mutation: top band red expected.
        const vp0 = await sendCdp(wc, 'Page.captureScreenshot', captureParams(false), CAPTURE_MS);
        if (vp0.ok) {
          const { img, size } = decodeCapture(vp0.result);
          const topPx = pixel(img, Math.floor(size.width / 2), Math.min(40, size.height - 1));
          report.baselineViewport = { ok: near(topPx, [255, 0, 0, 255]), ms: vp0.ms, size: [size.width, size.height], topPx };
        } else {
          report.baselineViewport = { ok: false, ms: vp0.ms, err: vp0.err };
        }

        // Same-target mutations (the MCP-style actions whose state must persist):
        const mut = await sendCdp(wc, 'Runtime.evaluate', { expression: MUTATE_EXPR, returnByValue: true }, 5000);
        report.preflight.mutation = mut.ok ? { ok: true, ms: mut.ms } : { ok: false, err: mut.err };
        await delay(150); // let the compositor see the style change

        // Full-page raster #1: single captureBeyondViewport call, full document
        // clip — never a re-navigation, never a stitched tile.
        const f1 = await sendCdp(wc, 'Page.captureScreenshot',
          captureParams(true, { x: 0, y: 0, width: W, height: FIXTURE.bandCss * 3, scale: 1 }), CAPTURE_MS);
        if (f1.ok) {
          report.full1 = { ms: f1.ms, ...checkFullRaster(f1.result, {
            top: [255, 255, 0, 255], mid: [0, 255, 255, 255], foot: [0, 0, 255, 255],
          }) };
        } else {
          report.full1 = { ok: false, ms: f1.ms, err: f1.err };
        }

        // Second mutation + second raster: proves capture #2 is a fresh frame of
        // the same live document, not a cached bitmap or a reloaded page.
        await sendCdp(wc, 'Runtime.evaluate', { expression: REMUTATE_EXPR, returnByValue: true }, 5000);
        await delay(150);
        const f2 = await sendCdp(wc, 'Page.captureScreenshot',
          captureParams(true, { x: 0, y: 0, width: W, height: FIXTURE.bandCss * 3, scale: 1 }), CAPTURE_MS);
        if (f2.ok) {
          report.full2 = { ms: f2.ms, ...checkFullRaster(f2.result, {
            top: [255, 255, 0, 255], mid: [255, 0, 255, 255], foot: [0, 0, 255, 255],
          }) };
        } else {
          report.full2 = { ok: false, ms: f2.ms, err: f2.err };
        }

        // Same-target readback: URL, unsaved form value, injected style, token —
        // the document must be the one the actions ran against, not a reload.
        const st = await sendCdp(wc, 'Runtime.evaluate', { expression: STATE_EXPR, returnByValue: true }, 5000);
        if (st.ok && st.result && st.result.result) report.state = st.result.result.value;
      }

      // Diagnostic only: Electron capturePage (viewport-bound native API) — a
      // reference point, never a full-page substitute.
      const cp = await bounded(wc.capturePage(), 8000);
      if (cp.outcome === 'ok' && cp.value && !cp.value.isEmpty()) {
        const s = cp.value.getSize();
        report.capturePageViewport = { ok: true, ms: 0, size: [s.width, s.height], bytes: cp.value.toPNG().length };
      } else {
        report.capturePageViewport = { ok: false, err: cp.outcome === 'timeout' ? 'TIMEOUT(8000ms)' : (cp.error || 'empty image') };
      }

      report.paintEvents = paintCount;
      const stateOk = isBlank ? true : Boolean(report.state && report.state.note === FORM_VALUE && report.state.token === TOKEN && report.state.mutation === 'applied' && report.state.styleOverride === true);
      const evalOk = Boolean(report.preflight.eval && report.preflight.eval.ok);
      const capsOk = isBlank
        ? Boolean(report.baselineViewport && report.baselineViewport.ok)
        : Boolean(report.baselineViewport && report.baselineViewport.ok && report.full1 && report.full1.ok && report.full2 && report.full2.ok);
      report.ok = evalOk && capsOk && stateOk;
    } catch (err) {
      report.error = String((err && err.stack) || err).split('\n').slice(0, 3).join(' | ');
    }

    // Emit before teardown so a wedged cleanup can never eat the report.
    console.log('PROBE_RESULT ' + JSON.stringify(report));

    try { if (surface && surface.wc && !surface.wc.isDestroyed()) surface.wc.debugger.detach(); } catch {}
    try { server && server.close(); } catch {}
    try { if (surface && surface.wc && !surface.wc.isDestroyed()) surface.wc.destroy(); } catch {}
    try { if (surface && surface.win && !surface.win.isDestroyed()) surface.win.destroy(); } catch {}
    try { fs.rmSync(tempUserData, { recursive: true, force: true }); } catch {}
    app.exit(report.ok ? 0 : 1);
  }).catch((err) => {
    console.log('PROBE_RESULT ' + JSON.stringify({ mode, ok: false, error: String((err && err.message) || err) }));
    try { fs.rmSync(tempUserData, { recursive: true, force: true }); } catch {}
    app.exit(1);
  });

  // Worker watchdog: never let a hung raster keep the child alive.
  setTimeout(() => {
    console.log('PROBE_RESULT ' + JSON.stringify({ mode, ok: false, error: 'WORKER_WATCHDOG_TIMEOUT' }));
    try { fs.rmSync(tempUserData, { recursive: true, force: true }); } catch {}
    app.exit(2);
  }, Math.max(20_000, Number(args['worker-timeout-ms']) || 60_000)).unref();
}

// ---------------------------------------------------------------------------

if (IS_WORKER) {
  const mode = (process.argv.find((a) => a.startsWith('--worker-mode=')) || '').split('=')[1];
  runWorker(mode);
} else {
  runSupervisor();
}
