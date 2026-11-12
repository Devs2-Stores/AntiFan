/**
 * Electron driver for terminal-glyph-atlas-font.test.ts.
 *
 * Renders text through the real xterm + WebGL addon from node_modules, on the Electron
 * binary of this checkout, with the same canvas-font shim and terminal options the
 * Terminal Manager page uses. Every font value the glyph atlas assigns to a 2D canvas
 * is recorded with the value the canvas actually kept, so the suite can tell a font the
 * runtime rejected (it silently keeps "10px sans-serif") from one it applied.
 *
 * Writes its receipt to ANTIFAN_DRIVER_EVIDENCE and exits; it never touches a profile,
 * data root or window of a running app.
 */
const { app, BrowserWindow } = require('electron');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { pathToFileURL } = require('node:url');

const repoRoot = process.env.ANTIFAN_DRIVER_REPO_ROOT;
const evidencePath = process.env.ANTIFAN_DRIVER_EVIDENCE;
const workDir = fs.mkdtempSync(path.join(os.tmpdir(), 'antifan-glyph-atlas-'));
app.setPath('userData', path.join(workDir, 'profile'));

const watchdog = setTimeout(() => {
  console.error('[terminal-glyph-atlas-font] watchdog: no result in 60 s');
  app.exit(3);
}, 60_000);

function asset(rel) {
  return pathToFileURL(path.join(repoRoot, rel)).href;
}

const page = `<!doctype html><html><head><meta charset="utf-8">
<link rel="stylesheet" href="${asset('node_modules/@xterm/xterm/css/xterm.css')}">
<style>html,body{margin:0;background:#080c13}#term{width:900px;height:300px}</style></head>
<body><div id="term"></div>
<script>
  // What the runtime does with xterm's font shorthand before any shim, for the receipt only.
  globalThis.__runtimeKeepsDefault = (() => {
    const c = document.createElement('canvas').getContext('2d');
    c.font = ' normal 12px monospace';
    return c.font === '10px sans-serif';
  })();
</script>
<script src="${asset('src/renderer/canvas-font-shim.js')}"></script>
<script>
  // Record every font assignment made through whatever setter is installed now (the shim's
  // when the runtime needs it), together with the value the canvas kept. The atlas reuses one
  // context, and a rejected value leaves the previous font in place, so a sentinel is set
  // first: a rejected value then reads back as the sentinel instead of an earlier valid font.
  globalThis.__fontWrites = [];
  const proto = CanvasRenderingContext2D.prototype;
  const desc = Object.getOwnPropertyDescriptor(proto, 'font');
  Object.defineProperty(proto, 'font', {
    configurable: true,
    enumerable: desc.enumerable,
    get: desc.get,
    set(value) {
      desc.set.call(this, '7px serif');
      desc.set.call(this, value);
      globalThis.__fontWrites.push({ requested: String(value), kept: desc.get.call(this) });
    },
  });
</script>
<script src="${asset('node_modules/@xterm/xterm/lib/xterm.js')}"></script>
<script src="${asset('node_modules/@xterm/addon-webgl/lib/addon-webgl.js')}"></script>
<script>
  const term = new Terminal({ fontFamily: 'Cascadia Mono, Consolas, monospace', fontSize: 12, cursorBlink: false });
  term.open(document.getElementById('term'));
  globalThis.__webgl = { attached: false, error: null };
  try {
    const addon = new WebglAddon.WebglAddon();
    addon.onContextLoss(() => { globalThis.__webgl.error = 'context-loss'; });
    term.loadAddon(addon);
    globalThis.__webgl.attached = true;
  } catch (err) {
    globalThis.__webgl.error = String((err && err.message) || err);
  }
  term.write('plain mmmiiiWWW 0123456789\\r\\n\\x1b[1mbold text\\x1b[0m \\x1b[3mitalic text\\x1b[0m\\r\\n');
</script></body></html>`;

app.whenReady().then(async () => {
  const pagePath = path.join(workDir, 'atlas.html');
  fs.writeFileSync(pagePath, page);
  const win = new BrowserWindow({ width: 960, height: 360, show: false, webPreferences: { backgroundThrottling: false } });
  const evidence = { scenario: 'terminal-glyph-atlas-font', electron: process.versions.electron };
  try {
    await win.loadFile(pagePath);
    // The atlas rasterises glyphs on the first render frames after the write.
    await win.webContents.executeJavaScript('new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(() => setTimeout(r, 500))))');
    Object.assign(evidence, await win.webContents.executeJavaScript(
      '({ runtimeKeepsDefault: globalThis.__runtimeKeepsDefault, webgl: globalThis.__webgl, fontWrites: globalThis.__fontWrites })',
    ));
  } catch (err) {
    evidence.error = String((err && err.stack) || err);
  }
  fs.writeFileSync(evidencePath, JSON.stringify(evidence, null, 2));
  console.log(`[terminal-glyph-atlas-font] electron ${evidence.electron} webgl=${evidence.webgl && evidence.webgl.attached} writes=${(evidence.fontWrites || []).length}`);
  clearTimeout(watchdog);
  try { fs.rmSync(workDir, { recursive: true, force: true }); } catch {}
  app.exit(0);
});
