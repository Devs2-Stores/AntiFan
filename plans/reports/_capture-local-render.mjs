/**
 * Local visual capture of the statically rendered home at the three required
 * breakpoints (390 / 768 / 1440), using a real headless Chrome over CDP.
 *
 * Context: the approved plan forbids remote push, so the local revision of the
 * home cannot be served by the storefront. This script serves the render
 * harness output over a local HTTP server (assets mapped to the theme asset
 * directory) and captures full-page screenshots plus overflow measurements.
 *
 * Evidence scope: this measures the LiquidJS-rendered markup under a real
 * browser engine. It is local visual evidence, NOT storefront verification.
 *
 * Read-only with respect to the theme. Writes PNGs + a JSON summary under
 * plans/reports/home-render/.
 *
 * Usage: node plans/reports/_capture-local-render.mjs
 */
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import * as http from 'node:http';
import { spawn } from 'node:child_process';

const THEME_DIR = path.resolve('themes/phukienmaymoc-copy');
const HTML_PATH = path.resolve('plans/reports/_render-diagnostic.html');
const OUT_DIR = path.resolve('plans/reports/home-render');
const PORT = 18477;
const CDP_PORT = 9344;
const LIVE_URL_INDEX = process.argv.indexOf('--url');
const LIVE_URL = LIVE_URL_INDEX >= 0 ? process.argv[LIVE_URL_INDEX + 1] : null;
const LIVE_THEME_ID = '1001512581';
const VIEWPORTS = [
  { name: '1440', width: 1440, height: 900 },
  { name: '768', width: 768, height: 900 },
  { name: '390', width: 390, height: 844 },
];

const CHROME_CANDIDATES = [
  path.join(process.env.PROGRAMFILES || 'C:\\Program Files', 'Google', 'Chrome', 'Application', 'chrome.exe'),
  path.join(process.env['PROGRAMFILES(X86)'] || 'C:\\Program Files (x86)', 'Google', 'Chrome', 'Application', 'chrome.exe'),
  process.env.LOCALAPPDATA ? path.join(process.env.LOCALAPPDATA, 'Google', 'Chrome', 'Application', 'chrome.exe') : '',
].filter(Boolean);
const CHROME_EXE = process.env.CHROME_EXE || CHROME_CANDIDATES.find((candidate) => fs.existsSync(candidate));

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.png': 'image/png',
  '.webp': 'image/webp',
  '.gif': 'image/gif',
  '.svg': 'image/svg+xml',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.ttf': 'font/ttf',
  '.eot': 'application/vnd.ms-fontobject',
};

function assetCandidates(name) {
  // Haravan serves `.scss.liquid` as `<name>.scss.css` and `.js.liquid` as
  // `<name>.js`, so a storefront asset reference maps to several file names.
  const candidates = [name, `${name}.liquid`];
  if (name.endsWith('.scss.css')) candidates.push(`${name.slice(0, -4)}.liquid`);
  if (name.endsWith('.css')) {
    candidates.push(`${name.slice(0, -4)}.scss.liquid`, `${name.slice(0, -4)}.css.liquid`, `${name.slice(0, -4)}.liquid`);
  }
  if (name.endsWith('.js')) candidates.push(`${name}.liquid`);
  return candidates;
}

function startServer() {
  const server = http.createServer((request, response) => {
    const url = new URL(request.url, `http://127.0.0.1:${PORT}`);
    const pathname = decodeURIComponent(url.pathname);
    if (pathname === '/' || pathname === '/index.html') {
      // The render harness renders templates/index.liquid, which is a fragment
      // with no document head; wrap it so the viewport meta the layout ships
      // applies and device emulation measures the real layout width.
      const fragment = fs.readFileSync(HTML_PATH, 'utf8');
      // layout/theme.liquid + master-include.liquid load the global stylesheets
      // that the fragment render never sees; without them the preview measures a
      // page with no global resets or body clipping.
      const layoutStyles = ['color_font.scss.css', 'hl-global.css', 'll-style-all.scss.css', 'animate.min.css']
        .map((name) => `<link rel="stylesheet" href="/assets/${name}">`)
        .join('\n');
      const wrapped = `<!doctype html>\n<html lang="vi">\n<head>\n<meta charset="utf-8">\n<meta name="viewport" content="width=device-width, initial-scale=1.0">\n${layoutStyles}\n</head>\n<body>\n${fragment}\n</body>\n</html>\n`;
      response.writeHead(200, { 'content-type': MIME['.html'] });
      response.end(wrapped);
      return;
    }
    const assetRelative = pathname.startsWith('/assets/') ? pathname.slice('/assets/'.length) : null;
    const candidates = assetRelative
      ? assetCandidates(assetRelative).map((name) => path.join(THEME_DIR, 'assets', name))
      : [path.join(THEME_DIR, pathname.replace(/^\//, ''))];
    const found = candidates.find((candidate) => fs.existsSync(candidate) && fs.statSync(candidate).isFile());
    if (!found) {
      response.writeHead(404);
      response.end('not found');
      return;
    }
    // Serve by the requested extension: Haravan assets ship as `.liquid`
    // templates (hl-home.js.liquid) and must be delivered as their target type.
    const requestedExt = path.extname(pathname);
    const mime = MIME[requestedExt] ?? MIME[path.extname(found)] ?? 'application/octet-stream';
    response.writeHead(200, { 'content-type': mime });
    response.end(fs.readFileSync(found));
  });
  return new Promise((resolve) => server.listen(PORT, '127.0.0.1', () => resolve(server)));
}

function waitForCdp(timeoutMs) {
  const start = Date.now();
  return new Promise((resolve) => {
    const tick = () => {
      const request = http.get(`http://127.0.0.1:${CDP_PORT}/json/version`, { timeout: 800 }, (res) => {
        res.resume();
        res.on('end', () => resolve(true));
      });
      const retry = () => {
        if (Date.now() - start > timeoutMs) return resolve(false);
        setTimeout(tick, 250);
      };
      request.on('error', retry);
      request.on('timeout', () => {
        request.destroy();
        retry();
      });
    };
    tick();
  });
}

function cdpJson(method, urlPath) {
  return new Promise((resolve, reject) => {
    const request = http.request(
      { host: '127.0.0.1', port: CDP_PORT, path: urlPath, method },
      (res) => {
        let body = '';
        res.on('data', (chunk) => (body += chunk));
        res.on('end', () => {
          try {
            resolve(JSON.parse(body));
          } catch (error) {
            reject(new Error(`CDP ${urlPath} returned unparsable body: ${body.slice(0, 200)}`));
          }
        });
      },
    );
    request.on('error', reject);
    request.end();
  });
}

class CdpSession {
  constructor(socket) {
    this.socket = socket;
    this.nextId = 1;
    this.pending = new Map();
    socket.addEventListener('message', (event) => {
      const message = JSON.parse(event.data);
      if (message.id && this.pending.has(message.id)) {
        const { resolve, reject } = this.pending.get(message.id);
        this.pending.delete(message.id);
        if (message.error) reject(new Error(message.error.message));
        else resolve(message.result);
      }
    });
  }

  send(method, params = {}) {
    const id = this.nextId++;
    this.socket.send(JSON.stringify({ id, method, params }));
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      setTimeout(() => {
        if (this.pending.has(id)) {
          this.pending.delete(id);
          reject(new Error(`CDP timeout: ${method}`));
        }
      }, 30000);
    });
  }
}

async function openSession(wsUrl) {
  const socket = new WebSocket(wsUrl);
  await new Promise((resolve, reject) => {
    socket.addEventListener('open', resolve, { once: true });
    socket.addEventListener('error', () => reject(new Error('websocket failed')), { once: true });
  });
  return new CdpSession(socket);
}

async function main() {
  if (!CHROME_EXE) throw new Error('Google Chrome not found (set CHROME_EXE)');
  if (!fs.existsSync(HTML_PATH)) throw new Error(`render harness output missing: ${HTML_PATH}`);
  fs.mkdirSync(OUT_DIR, { recursive: true });

  const server = await startServer();
  const userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'antifan-chrome-'));
  const chrome = spawn(
    CHROME_EXE,
    [
      '--headless=new',
      `--remote-debugging-port=${CDP_PORT}`,
      `--user-data-dir=${userDataDir}`,
      '--no-first-run',
      '--no-default-browser-check',
      '--disable-gpu',
      '--hide-scrollbars',
      'about:blank',
    ],
    { stdio: 'ignore' },
  );

  const results = [];
  try {
    if (!(await waitForCdp(20000))) throw new Error('CDP endpoint did not become ready');
    const version = await cdpJson('GET', '/json/version');
    const target = await cdpJson('PUT', `/json/new?${encodeURIComponent('about:blank')}`);
    const session = await openSession(target.webSocketDebuggerUrl);
    await session.send('Page.enable');
    await session.send('Runtime.enable');
    await session.send('Page.addScriptToEvaluateOnNewDocument', {
      source: [
        'window.__localCaptureErrors = [];',
        "window.addEventListener('error', function (event) {",
        "  var target = event.target || {};",
        "  window.__localCaptureErrors.push({",
        "    kind: event.message ? 'script' : 'resource',",
        "    message: String(event.message || ''),",
        "    source: String(target.src || target.href || ''),",
        "    detail: String((event.error && event.error.message) || '')",
        '  });',
        '}, true);',
      ].join('\n'),
    });

    for (const viewport of VIEWPORTS) {
      await session.send('Emulation.setDeviceMetricsOverride', {
        width: viewport.width,
        height: viewport.height,
        deviceScaleFactor: 1,
        mobile: viewport.width <= 480,
      });
      const targetUrl = LIVE_URL
        ? `${LIVE_URL}${LIVE_URL.includes('themeid=') ? '' : `${LIVE_URL.includes('?') ? '&' : '?'}themeid=${LIVE_THEME_ID}`}`
        : `http://127.0.0.1:${PORT}/`;
      await session.send('Page.navigate', { url: targetUrl });
      await new Promise((resolve) => setTimeout(resolve, LIVE_URL ? 6000 : 2500));
      const metrics = await session.send('Runtime.evaluate', {
        expression: `(() => {
          const images = [...document.images];
          const isClipped = (el) => {
            let node = el.parentElement;
            while (node && node !== document.documentElement) {
              const overflowX = getComputedStyle(node).overflowX;
              if (overflowX !== 'visible') return true;
              node = node.parentElement;
            }
            return false;
          };
          const overflowing = [...document.querySelectorAll('*')]
            .map((el) => ({ el, rect: el.getBoundingClientRect() }))
            .filter(({ el, rect }) => rect.right > window.innerWidth + 1 && rect.width > 0 && !isClipped(el))
            .sort((a, b) => b.rect.right - a.rect.right)
            .slice(0, 12)
            .map(({ el, rect }) => ({
              tag: el.tagName.toLowerCase(),
              cls: String(el.className || '').slice(0, 70),
              id: el.id || '',
              section: (el.closest('section') || {}).className || '',
              right: Math.round(rect.right),
              width: Math.round(rect.width),
              naturalWidth: el.tagName === 'IMG' ? el.naturalWidth : undefined,
              src: el.tagName === 'IMG' ? String(el.getAttribute('src') || '').slice(-60) : undefined,
            }));
          return {
            innerWidth: window.innerWidth,
            visualViewportWidth: window.visualViewport ? Math.round(window.visualViewport.width) : null,
            devicePixelRatio: window.devicePixelRatio,
            scrollWidth: document.documentElement.scrollWidth,
            scrollHeight: document.documentElement.scrollHeight,
            bodyHeight: document.body.scrollHeight,
            overflowing: document.documentElement.scrollWidth > window.innerWidth + 1,
            images: images.length,
            imagesLoaded: images.filter((img) => img.complete && img.naturalWidth > 0).length,
            imagesBroken: images.filter((img) => img.complete && img.naturalWidth === 0).map((img) => img.getAttribute('src')).slice(0, 20),
            sections: [...document.querySelectorAll('section')].map((section) => section.className),
            sectionAudit: [...document.querySelectorAll('section')].map((section) => {
              const sectionImages = [...section.querySelectorAll('img')];
              const box = section.getBoundingClientRect();
              return {
                cls: section.className,
                height: Math.round(box.height),
                width: Math.round(box.width),
                display: getComputedStyle(section).display,
                textLength: section.innerText.trim().length,
                images: sectionImages.length,
                imagesLoaded: sectionImages.filter((img) => img.complete && img.naturalWidth > 0).length,
                links: section.querySelectorAll('a').length,
              };
            }),
            scripts: [...document.scripts].map((script) => script.src).filter(Boolean),
            errors: (window.__localCaptureErrors || []).slice(0, 8),
            overflowingElements: overflowing,
          };
        })()`,
        returnByValue: true,
      });
      const screenshot = await session.send('Page.captureScreenshot', {
        format: 'png',
        captureBeyondViewport: true,
      });
      const file = path.join(
        OUT_DIR,
        LIVE_URL ? `live-home-${viewport.name}.png` : `home-${viewport.name}.png`,
      );
      fs.writeFileSync(file, Buffer.from(screenshot.data, 'base64'));
      results.push({ viewport, file, ...metrics.result.value });
    }
    await session.send('Target.closeTarget', { targetId: target.id }).catch(() => {});
  } finally {
    chrome.kill();
    server.close();
  }

  const summary = {
    recordedAt: new Date().toISOString(),
    harness: 'plans/reports/_capture-local-render.mjs',
    chrome: CHROME_EXE,
    mode: LIVE_URL ? 'live-storefront-read-only' : 'local-static-render',
    navigatedUrl: LIVE_URL ?? `http://127.0.0.1:${PORT}/`,
    sourceHtml: path.relative(process.cwd(), HTML_PATH),
    scope: LIVE_URL
      ? `Read-only measurement of the deployed storefront at ${LIVE_URL} with ?themeid=${LIVE_THEME_ID}. The deployed revision predates this session's home changes (no remote push is permitted by the approved plan), so this is a baseline, not verification of the new code.`
      : 'Local visual evidence for the LiquidJS-rendered home. The local revision is not pushable under the approved plan, so this is not storefront verification.',
    results: results.map((entry) => ({
      breakpoint: entry.viewport.name,
      width: entry.viewport.width,
      innerWidth: entry.innerWidth,
      visualViewportWidth: entry.visualViewportWidth,
      devicePixelRatio: entry.devicePixelRatio,
      // A verdict about a breakpoint is only meaningful when the emulated
      // viewport actually became the layout viewport.
      viewportApplied: entry.innerWidth === entry.viewport.width,
      screenshot: path.relative(process.cwd(), entry.file),
      overflowing: entry.overflowing,
      scrollWidth: entry.scrollWidth,
      scrollHeight: entry.scrollHeight,
      images: entry.images,
      imagesLoaded: entry.imagesLoaded,
      imagesBrokenCount: entry.imagesBroken.length,
      imagesBroken: entry.imagesBroken,
      sectionCount: entry.sections.length,
      scripts: entry.scripts,
      pageErrors: entry.errors,
      overflowingElements: entry.overflowingElements,
      sectionAudit: entry.sectionAudit,
    })),
  };
  const summaryName = LIVE_URL
    ? 'live-summary.json'
    : 'summary.json';
  fs.writeFileSync(path.join(OUT_DIR, summaryName), `${JSON.stringify(summary, null, 2)}\n`, 'utf8');
  process.stdout.write(`${JSON.stringify(summary, null, 2)}\n`);
}

main().catch((error) => {
  process.stderr.write(`LOCAL_CAPTURE_FAILED ${error.stack ?? error}\n`);
  process.exitCode = 1;
});
