// Fixture lane for src/main/qa/probes/cart-contract.ts.
// Run: node scripts/run-electron.cjs test/e2e/cart-contract-fixtures-probe.cjs [--only=<id-prefix>]
// Each scenario starts a local HTTP server that serves one cart page (good, broken or empty) and an
// in-memory /cart.js, /cart/change.js and /cart/add.js, so the probe runs against a real document
// with real fetch and trusted CDP mouse input (Input.dispatchMouseEvent, never element.click()).
// Nothing leaves 127.0.0.1 and a developer's running AntiFan instance is never touched.
const { app, BrowserWindow } = require('electron');
const fs = require('node:fs');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');
const esbuild = require('esbuild');
const { LINE, createCartBackend, cartPageHtml } = require('../fixtures/probes/cart-fixtures.cjs');

const root = path.resolve(__dirname, '../..');
const only = (process.argv.find((arg) => arg.startsWith('--only=')) || '').slice(7);
const viewports = [
  { name: 'desktop', width: 1280, height: 800, deviceScaleFactor: 1, mobile: false },
  { name: 'mobile', width: 390, height: 844, deviceScaleFactor: 2, mobile: true },
];
const workDir = fs.mkdtempSync(path.join(os.tmpdir(), 'antifan-cart-contract-'));
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

const mutationRequests = (backend) => backend.requests.filter((r) => r !== 'GET /cart.js');
const ruleIds = (result) => result.findings.map((f) => f.ruleId);
const count = (result, ruleId) => result.findings.filter((f) => f.ruleId === ruleId).length;

// expect(result, backend) returns a list of failure strings.
const scenarios = [
  {
    id: 'cart-good-passive',
    variant: 'good',
    options: {},
    expect: (r, b) => {
      const f = [];
      if (r.measured !== true || r.passed !== true) f.push(`measured=${r.measured} passed=${r.passed} ${JSON.stringify(r.findings)}`);
      if (r.findings.length !== 0) f.push(`findings ${ruleIds(r).join(',')}`);
      if (JSON.stringify(r.data.controls) !== JSON.stringify({ plus: 1, minus: 1, remove: 1, quantityInput: 1, checkout: 1 })) f.push(`controls ${JSON.stringify(r.data.controls)}`);
      if (mutationRequests(b).length !== 0) f.push(`a passive run sent ${mutationRequests(b).join(',')}`);
      return f;
    },
  },
  {
    id: 'cart-good-exercise',
    variant: 'good',
    options: { exerciseCart: true },
    expect: (r, b) => {
      const f = [];
      if (r.passed !== true || r.findings.length !== 0) f.push(`passed=${r.passed} ${JSON.stringify(r.findings)}`);
      const steps = r.data.steps.map((s) => `${s.control}:${s.quantityBefore}->${s.quantityAfter}:${s.requestMade}`).join(' ');
      if (steps !== 'plus:2->3:true minus:3->2:true') f.push(`steps ${steps}`);
      if (b.items[0].quantity !== LINE.quantity) f.push(`quantity ${b.items[0].quantity} was not restored to ${LINE.quantity}`);
      if (r.data.restored !== 'not-needed') f.push(`restored ${r.data.restored}`);
      return f;
    },
  },
  {
    id: 'cart-good-remove',
    variant: 'good',
    options: { exerciseCart: true, allowRemove: true },
    expect: (r, b) => {
      const f = [];
      if (r.passed !== true) f.push(`passed=${r.passed} ${JSON.stringify(r.findings)}`);
      const remove = r.data.steps.find((s) => s.control === 'remove');
      if (!remove || !remove.requestMade) f.push(`remove step ${JSON.stringify(remove)}`);
      if (b.items.length !== 1 || b.items[0].quantity !== LINE.quantity) f.push(`cart after run ${JSON.stringify(b.items)}`);
      if (mutationRequests(b).slice(-1)[0] !== 'POST /cart/add.js') f.push(`last request ${mutationRequests(b).slice(-1)[0]}`);
      if (r.data.restored !== 'direct') f.push(`restored ${r.data.restored}`);
      return f;
    },
  },
  {
    id: 'cart-broken-passive',
    variant: 'broken',
    options: {},
    expect: (r, b) => {
      const f = [];
      if (r.passed !== false) f.push(`passed=${r.passed}`);
      if (count(r, 'checkout-target-invalid') !== 1) f.push(`checkout-target-invalid x${count(r, 'checkout-target-invalid')} in ${ruleIds(r).join(',')}`);
      if (mutationRequests(b).length !== 0) f.push(`a passive run sent ${mutationRequests(b).join(',')}`);
      return f;
    },
  },
  {
    id: 'cart-broken-exercise',
    variant: 'broken',
    options: { exerciseCart: true },
    expect: (r, b) => {
      const f = [];
      if (r.passed !== false) f.push(`passed=${r.passed}`);
      if (count(r, 'cart-control-no-request') !== 2) f.push(`cart-control-no-request x${count(r, 'cart-control-no-request')} in ${ruleIds(r).join(',')}`);
      if (count(r, 'checkout-target-invalid') !== 1) f.push(`checkout-target-invalid x${count(r, 'checkout-target-invalid')}`);
      if (mutationRequests(b).length !== 0) f.push(`dead buttons reached the cart: ${mutationRequests(b).join(',')}`);
      return f;
    },
  },
  {
    id: 'cart-empty',
    variant: 'empty',
    options: { exerciseCart: true, allowRemove: true },
    expect: (r, b) => {
      const f = [];
      if (r.measured !== false || r.passed !== null) f.push(`measured=${r.measured} passed=${r.passed}`);
      if (ruleIds(r).join(',') !== 'QA_EMPTY_CART_NOT_EXERCISED') f.push(`findings ${ruleIds(r).join(',')}`);
      if (mutationRequests(b).length !== 0 || b.items.length !== 0) f.push(`the probe changed an empty cart: ${mutationRequests(b).join(',')}`);
      return f;
    },
  },
];

function startServer(variant) {
  const backend = createCartBackend(variant === 'empty' ? [] : [LINE]);
  const server = http.createServer((req, res) => {
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => {
      const pathname = new URL(req.url, 'http://127.0.0.1').pathname;
      if (pathname === '/cart' && req.method === 'GET') {
        res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
        res.end(cartPageHtml(variant, backend.items[0] ? backend.items[0].quantity : LINE.quantity));
        return;
      }
      const reply = backend.handle(req.method, req.url, Buffer.concat(chunks).toString('utf8'));
      res.writeHead(reply.status, { 'content-type': 'application/json' });
      res.end(JSON.stringify(reply.json));
    });
  });
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve({ server, backend, port: server.address().port })));
}

async function openAt(vp, url) {
  const win = new BrowserWindow({
    show: false, x: -4000, y: 0, useContentSize: true, width: vp.width, height: vp.height,
    skipTaskbar: true, focusable: false, webPreferences: { backgroundThrottling: false },
  });
  win.showInactive();
  await win.loadURL(url);
  const dbg = win.webContents.debugger;
  dbg.attach('1.3');
  await dbg.sendCommand('Emulation.setDeviceMetricsOverride', vp);
  await sleep(150);
  return { win, dbg };
}

function makeDeps(win, dbg) {
  const js = (code) => win.webContents.executeJavaScript(code);
  const mouse = (type, x, y, extra = {}) => dbg.sendCommand('Input.dispatchMouseEvent', { type, x, y, button: 'left', ...extra });
  return {
    evalJs: (script) => js(script),
    click: async (selector) => {
      const c = await js(`(() => {
        const el = document.querySelector(${JSON.stringify(selector)});
        if (!el) return { ok: false, error: 'SELECTOR_NOT_FOUND' };
        el.scrollIntoView({ block: 'center' });
        const r = el.getBoundingClientRect();
        if (r.width <= 0 || r.height <= 0) return { ok: false, error: 'ZERO_BOX' };
        const x = Math.round(r.left + r.width / 2); const y = Math.round(r.top + r.height / 2);
        const hit = document.elementFromPoint(x, y);
        if (!hit || (hit !== el && !el.contains(hit))) return { ok: false, error: 'OCCLUDED' };
        return { ok: true, x, y };
      })()`);
      if (!c.ok) return c;
      await mouse('mouseMoved', c.x, c.y, { button: 'none' });
      await mouse('mousePressed', c.x, c.y, { clickCount: 1 });
      await mouse('mouseReleased', c.x, c.y, { clickCount: 1 });
      return { ok: true };
    },
    hover: async () => ({ ok: true }),
    wait: (ms) => sleep(ms),
  };
}

async function run() {
  const bundled = path.join(workDir, 'cart-contract.cjs');
  await esbuild.build({ entryPoints: [path.join(root, 'src/main/qa/probes/cart-contract.ts')], bundle: true, platform: 'node', format: 'cjs', outfile: bundled, logLevel: 'error' });
  const { runCartContract } = require(bundled);
  const chosen = scenarios.filter((s) => !only || s.id.startsWith(only));
  if (chosen.length === 0) throw new Error(`No scenario matches --only=${only}`);
  let failed = 0;
  let passed = 0;
  for (const scenario of chosen) {
    for (const vp of viewports) {
      const { server, backend, port } = await startServer(scenario.variant);
      const { win, dbg } = await openAt(vp, `http://127.0.0.1:${port}/cart`);
      try {
        const result = await runCartContract(makeDeps(win, dbg), scenario.options);
        const failures = scenario.expect(result, backend);
        if (failures.length === 0) {
          passed++;
          console.log(`PASS ${scenario.id}@${vp.name}`);
        } else {
          failed++;
          console.log(`FAIL ${scenario.id}@${vp.name}: ${failures.join('; ')}`);
        }
      } finally {
        try { dbg.detach(); } catch {}
        win.destroy();
        server.close();
      }
    }
  }
  console.log(`SUMMARY pass=${passed} fail=${failed}`);
  exitCode = failed > 0 ? 1 : 0;
}

app.whenReady().then(run).then(() => app.exit(exitCode), fail);
