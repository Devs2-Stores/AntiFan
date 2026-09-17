/**
 * Probe: what does a target page inject *after* its own markup has parsed?
 *
 * A static snapshot is materialized from the DOM the server delivered plus what
 * the walk triggered. Anything the page injects later (timed promo popups,
 * backend-gated dialogs) is absent from the snapshot and can never be
 * reproduced offline, yet it changes the pixels a parity diff measures. This
 * probe records those nodes, their geometry and whether they existed at
 * DOMContentLoaded, so a visual gate can normalize the state explicitly.
 *
 * Usage: node scripts/run-electron.cjs scripts/probe-dynamic-overlays.cjs <url> [--text TÍCH]
 */
'use strict';

const { app, BrowserWindow, session } = require('electron');
const fs = require('node:fs');
const path = require('node:path');

const url = process.argv.find((a) => /^https?:/.test(a));
const textFlagIndex = process.argv.indexOf('--text');
const probeText = textFlagIndex > -1 ? process.argv[textFlagIndex + 1] : null;

if (!url) {
  console.error('[probe] usage: node scripts/run-electron.cjs scripts/probe-dynamic-overlays.cjs <url> [--text <substring>]');
  process.exit(2);
}

const MARK_SCRIPT = `(() => {
  const mark = () => {
    window.__antifanInitialNodes = new WeakSet();
    document.querySelectorAll('*').forEach((el) => window.__antifanInitialNodes.add(el));
    window.__antifanInitialReady = true;
  };
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', mark, { once: true });
  else mark();
})();`;

const REPORT_SCRIPT = (needle) => `(() => {
  const initial = window.__antifanInitialNodes;
  const area = (el) => { const r = el.getBoundingClientRect(); return Math.round(r.width * r.height); };
  const describe = (el) => {
    const style = window.getComputedStyle(el);
    const r = el.getBoundingClientRect();
    return {
      tag: el.tagName.toLowerCase(),
      cls: String(el.className || '').slice(0, 120),
      id: el.id || null,
      position: style.position,
      zIndex: style.zIndex,
      display: style.display,
      opacity: style.opacity,
      rect: { x: Math.round(r.x), y: Math.round(r.y), w: Math.round(r.width), h: Math.round(r.height) },
      areaPercent: Number(((r.width * r.height) / (window.innerWidth * window.innerHeight) * 100).toFixed(2)),
      initial: initial ? initial.has(el) : null,
      ancestorInitial: initial ? (() => { let p = el.parentElement; while (p) { if (initial.has(p)) return true; p = p.parentElement; } return false; })() : null,
      text: (el.textContent || '').trim().slice(0, 60),
      background: style.backgroundColor,
      ancestors: (() => { const out = []; let p = el.parentElement; let i = 0; while (p && i < 3) { out.push({ tag: p.tagName.toLowerCase(), cls: String(p.className || '').slice(0, 70), pos: getComputedStyle(p).position, z: getComputedStyle(p).zIndex }); p = p.parentElement; i++; } return out; })(),
    };
  };
  const named = '[role="dialog"], [aria-modal="true"], [class*="modal"], [class*="popup"], [class*="dialog"], [class*="drawer"], [class*="overlay"], [class*="promo"], [class*="toast"], [class*="voucher"], [class*="coupon"], [class*="gift"]';
  const nodes = new Set(Array.from(document.querySelectorAll(named)));
  // A promo overlay is often an unnamed div inside a named wrapper, so geometry is
  // the second net: anything visible, positioned and layered enough to cover page
  // content is reported regardless of its class names.
  for (const el of Array.from(document.querySelectorAll('body *'))) {
    const style = window.getComputedStyle(el);
    if (style.display === 'none' || style.visibility === 'hidden') continue;
    if (style.position !== 'fixed' && style.position !== 'absolute') continue;
    const z = Number.parseInt(style.zIndex, 10);
    if (!Number.isFinite(z) || z < 40) continue;
    const r = el.getBoundingClientRect();
    if (r.width * r.height < window.innerWidth * window.innerHeight * 0.03) continue;
    nodes.add(el);
  }
  const candidates = Array.from(nodes)
    .filter((el) => {
      const style = window.getComputedStyle(el);
      if (style.display === 'none' || style.visibility === 'hidden') return false;
      const r = el.getBoundingClientRect();
      return r.width * r.height > 0;
    })
    .map(describe)
    .sort((a, b) => b.areaPercent - a.areaPercent)
    .slice(0, 25);

  const needle = ${JSON.stringify(needle)};
  const hit = needle ? (() => {
    const match = Array.from(document.querySelectorAll('*')).find((el) => (el.textContent || '').includes(needle) && el.children.length === 0);
    if (!match) return null;
    let node = match;
    while (node.parentElement && !/^(div|section|aside|dialog)$/.test(node.tagName.toLowerCase())) node = node.parentElement;
    return describe(node);
  })() : null;

  // Top-level body children that did not exist when the document finished parsing.
  const bodyChildren = Array.from(document.body.children).map((el) => ({
    tag: el.tagName.toLowerCase(),
    cls: String(el.className || '').slice(0, 80),
    initial: initial ? initial.has(el) : null,
    h: Math.round(el.getBoundingClientRect().height),
  }));

  return {
    url: location.href,
    markerReady: !!window.__antifanInitialReady,
    viewport: { w: window.innerWidth, h: window.innerHeight },
    documentHeight: document.documentElement.scrollHeight,
    candidates,
    needleHit: hit,
    bodyChildren,
  };
})()`;

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

app.on('window-all-closed', () => {});

app.whenReady().then(async () => {
  const window_ = new BrowserWindow({
    width: 1440,
    height: 900,
    show: false,
    focusable: false,
    frame: false,
    webPreferences: { offscreen: false, backgroundThrottling: false, contextIsolation: false, nodeIntegration: false },
  });
  // Tracker beacons can hold the load event open indefinitely and are absent from
  // any offline package, so the probe refuses them exactly like the parity gate.
  session.fromPartition('default').webRequest.onBeforeRequest({ urls: ['*://*/*'] }, (details, callback) => {
    let host = null;
    try { host = new URL(details.url).hostname.toLowerCase(); } catch (e) {}
    const blocked = ['connect.facebook.net', 'facebook.com', 'facebook.net', 'googletagmanager.com', 'google-analytics.com', 'doubleclick.net', 'hotjar.com', 'clarity.ms', 'tiktok.com', 'zalo.me', 'tawk.to', 'subiz.com', 'crisp.chat', 'intercom.io', 'livechatinc.com'];
    callback({ cancel: Boolean(host && blocked.some((b) => host === b || host.endsWith('.' + b))) });
  });
  const wc = window_.webContents;
  wc.debugger.attach('1.3');
  await wc.debugger.sendCommand('Page.enable');
  await wc.debugger.sendCommand('Emulation.setDeviceMetricsOverride', {
    width: 1440, height: 900, deviceScaleFactor: 1, mobile: false,
  });
  await wc.debugger.sendCommand('Page.addScriptToEvaluateOnNewDocument', { source: MARK_SCRIPT });

  await wc.loadURL(url);
  await sleep(1500);
  const early = await wc.executeJavaScript(REPORT_SCRIPT(probeText), true);

  // Walk the page the way the clone materializer does, then look again.
  await wc.executeJavaScript(`(async () => {
    const step = 300;
    for (let y = 0; y < document.documentElement.scrollHeight; y += step) {
      window.scrollTo(0, y);
      await new Promise((r) => setTimeout(r, 120));
    }
    window.scrollTo(0, 0);
  })()`, true);
  await sleep(2500);
  const after = await wc.executeJavaScript(REPORT_SCRIPT(probeText), true);

  const payload = { url, probeText, early, afterWalk: after };
  const outDir = path.join(__dirname, '..', 'plans', 'reports');
  fs.mkdirSync(outDir, { recursive: true });
  const outFile = path.join(outDir, 'dynamic-overlay-probe.json');
  fs.writeFileSync(outFile, `${JSON.stringify(payload, null, 2)}\n`);
  console.log(`[probe] wrote ${outFile}`);
  console.log(`[probe] early: ${JSON.stringify(early.candidates.slice(0, 5))}`);
  console.log(`[probe] needle(e)\u2192 ${JSON.stringify(early.needleHit)}`);
  console.log(`[probe] after: ${JSON.stringify(after.candidates.slice(0, 5))}`);
  console.log(`[probe] needle(a)\u2192 ${JSON.stringify(after.needleHit)}`);
  app.exit(0);
}).catch((error) => {
  console.error('[probe] failed:', error && error.stack ? error.stack : error);
  app.exit(1);
});
