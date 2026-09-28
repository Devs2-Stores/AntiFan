'use strict';
// Isolated raw-CDP comparison; no attachment to the user's browser or profile.
const { app, nativeImage } = require('electron');
const { spawn } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');
const assert = require('node:assert/strict');
const WebSocket = require('ws');
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'antifan-headless-capture-'));
app.setPath('userData', path.join(root, 'electron'));
let child, socket, server;
const pending = new Map();
let nextId = 0;
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
function command(method, params = {}) {
  return new Promise((resolve, reject) => {
    const id = ++nextId;
    const timer = setTimeout(() => { pending.delete(id); reject(new Error(`${method} timed out`)); }, 8000);
    pending.set(id, { resolve, reject, timer });
    socket.send(JSON.stringify({ id, method, params }));
  });
}
async function run() {
  const executable = 'C:/Program Files/Google/Chrome/Application/chrome.exe';
  assert.ok(fs.existsSync(executable), 'System Chrome unavailable');
  server = http.createServer((_req, res) => {
    res.setHeader('Content-Type', 'text/html');
    res.end('<!doctype html><style>body{margin:0}.band{height:800px}#top{background:rgb(255,0,0)}#middle{background:rgb(0,255,0)}#bottom{background:rgb(0,0,255)}</style><div class="band" id="top"><input id="note"></div><div class="band" id="middle"></div><div class="band" id="bottom"></div>');
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const profile = path.join(root, 'chrome');
  child = spawn(executable, ['--headless=new', '--remote-debugging-port=0', '--remote-debugging-address=127.0.0.1', `--user-data-dir=${profile}`, '--no-first-run', '--no-default-browser-check', 'about:blank'], { stdio: 'ignore' });
  child.on('error', error => console.error(error));
  const portFile = path.join(profile, 'DevToolsActivePort');
  for (let i = 0; i < 100 && !fs.existsSync(portFile); i++) await delay(100);
  assert.ok(fs.existsSync(portFile), 'No Chrome debug endpoint after 10 seconds');
  const port = Number(fs.readFileSync(portFile, 'utf8').split('\n')[0]);
  const targets = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json();
  const target = targets.find(item => item.type === 'page');
  assert.ok(target, 'No page target');
  socket = new WebSocket(target.webSocketDebuggerUrl);
  await new Promise((resolve, reject) => { socket.once('open', resolve); socket.once('error', reject); });
  socket.on('message', data => {
    const message = JSON.parse(data.toString());
    const request = pending.get(message.id);
    if (!request) return;
    pending.delete(message.id); clearTimeout(request.timer);
    if (message.error) request.reject(new Error(JSON.stringify(message.error))); else request.resolve(message.result);
  });
  const version = await command('Browser.getVersion');
  await command('Emulation.setDeviceMetricsOverride', { width: 800, height: 600, deviceScaleFactor: 1, mobile: false });
  const url = `http://127.0.0.1:${server.address().port}/`;
  await command('Page.navigate', { url });
  for (let i = 0; i < 100; i++) {
    const result = await command('Runtime.evaluate', { expression: 'Boolean(document.getElementById("bottom"))', returnByValue: true });
    if (result.result.value) break;
    await delay(50);
  }
  const results = [];
  for (const color of ['rgb(255, 255, 0)', 'rgb(0, 255, 255)']) {
    await command('Runtime.evaluate', { expression: `document.getElementById('note').value='unsaved';document.getElementById('middle').style.background=${JSON.stringify(color)};window.captureIdentity ||= 'same-document'`, returnByValue: true });
    const start = Date.now();
    const capture = await command('Page.captureScreenshot', { format: 'png', fromSurface: true, captureBeyondViewport: true, clip: { x: 0, y: 0, width: 800, height: 2400, scale: 1 } });
    const image = nativeImage.createFromBuffer(Buffer.from(capture.data, 'base64'));
    assert.deepEqual(image.getSize(), { width: 800, height: 2400 });
    const pixels = image.toBitmap();
    const pixel = y => Array.from(pixels.subarray((y * 800 + 400) * 4, (y * 800 + 400) * 4 + 4));
    assert.deepEqual(pixel(400), [0, 0, 255, 255]);
    assert.deepEqual(pixel(1200), color.includes('255, 255, 0') ? [0, 255, 255, 255] : [255, 255, 0, 255]);
    assert.deepEqual(pixel(2000), [255, 0, 0, 255]);
    const state = (await command('Runtime.evaluate', { expression: '({note:document.getElementById("note").value,identity:window.captureIdentity,width:innerWidth,height:innerHeight,url:location.href})', returnByValue: true })).result.value;
    assert.deepEqual(state, { note: 'unsaved', identity: 'same-document', width: 800, height: 600, url });
    results.push({ ms: Date.now() - start, size: image.getSize(), top: pixel(400), middle: pixel(1200), footer: pixel(2000), state });
  }
  console.log('HEADLESS_CAPTURE_RESULT ' + JSON.stringify({ version, targetId: target.id, results }));
  await command('Browser.close').catch(() => {});
}
app.whenReady().then(async () => {
  let code = 0;
  try { await run(); } catch (error) { code = 1; console.error(error); }
  finally {
    for (const request of pending.values()) clearTimeout(request.timer);
    socket?.close();
    if (child && child.exitCode === null) { child.kill(); await delay(500); }
    server?.closeAllConnections();
    if (server) await new Promise(resolve => server.close(resolve));
    try { fs.rmSync(root, { recursive: true, force: true }); } catch (error) { console.error('Profile cleanup:', error.message); }
    app.exit(code);
  }
});
setTimeout(() => { child?.kill(); app.exit(2); }, 45000).unref();
