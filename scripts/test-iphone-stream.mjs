import http from 'node:http';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const { WebSocketServer } = require('ws');
const { listUsbmuxDevices, connectDevicePort } = require('../.compiled/src/main/device/usbmux-client.js');
const { createUsbmuxPortForwarder } = require('../.compiled/src/main/device/usbmux-forwarder.js');

let currentDeviceNumber = null;
let currentSessionId = null;
let mjpegForwarder = null;

async function getDevice() {
  const devices = await listUsbmuxDevices();
  if (devices.length === 0) throw new Error('No iOS device connected via USB');
  return devices[0];
}

async function sendWdaRequest(deviceNumber, method, path, body = null) {
  const { socket } = await connectDevicePort(deviceNumber, 8100, 4000);
  const jsonBody = body ? JSON.stringify(body) : null;
  const headers = [
    `${method} ${path} HTTP/1.1`,
    'Host: localhost',
    'Connection: close',
  ];
  if (jsonBody) {
    headers.push('Content-Type: application/json');
    headers.push(`Content-Length: ${Buffer.byteLength(jsonBody)}`);
  }
  const payload = headers.join('\r\n') + '\r\n\r\n' + (jsonBody || '');

  return new Promise((resolve, reject) => {
    socket.setTimeout(10000, () => socket.destroy(new Error('WDA response timeout')));
    socket.write(payload);
    let raw = '';
    socket.on('data', d => raw += d.toString('utf8'));
    socket.on('end', () => {
      const headerEnd = raw.indexOf('\r\n\r\n');
      if (headerEnd === -1) return reject(new Error('Invalid HTTP response'));
      const headerText = raw.slice(0, headerEnd);
      const statusLine = headerText.split('\r\n')[0];
      const statusCode = parseInt(statusLine.split(' ')[1], 10);
      const bodyText = raw.slice(headerEnd + 4);
      let parsed = null;
      try { parsed = JSON.parse(bodyText); } catch {}
      if (statusCode < 200 || statusCode >= 300 || !parsed || parsed.value?.error) {
        reject(new Error(parsed?.value?.message || `WDA HTTP ${statusCode}`));
        return;
      }
      resolve({ status: statusCode, body: parsed, raw: bodyText });
    });
    socket.on('error', reject);
  });
}

async function syncWdaSessionAndSettings(deviceNumber) {
  try {
    const statusRes = await sendWdaRequest(deviceNumber, 'GET', '/status');
    const sid = statusRes.body?.sessionId || statusRes.body?.value?.sessionId;
    if (!sid) {
      currentSessionId = null;
      throw new Error('WDA has no active session');
    }
    if (currentSessionId === sid) return sid;
    // Configure high-FPS, zero-delay settings once per session
    // Configure high-FPS, crisp Retina quality & zero-delay settings
    await sendWdaRequest(deviceNumber, 'POST', `/session/${sid}/appium/settings`, {
      settings: {
        mjpegServerFramerate: 60,
        mjpegScalingFactor: 33,
        mjpegServerScreenshotQuality: 28,
        waitForIdleTimeout: 0,
        animationCoolOffTimeout: 0,
      }
    });
    currentSessionId = sid;
    console.log('[AntiFan Stream] WDA configured for 60 FPS & 0ms quiescence');
    return sid;
  } catch (err) {
    console.warn('[AntiFan Stream] Sync settings error:', err.message);
    return null;
  }
}

async function tapDevice(deviceNumber, x, y) {
  if (!currentSessionId) {
    await syncWdaSessionAndSettings(deviceNumber);
  }
  if (!currentSessionId) {
    throw new Error('NO_WDA_SESSION: Cannot tap without an active WebDriverAgent session');
  }

  const pointX = Math.max(0, Math.min(390, Math.round(x)));
  const pointY = Math.max(0, Math.min(844, Math.round(y)));

  // Direct WDA tap endpoint
  const res = await sendWdaRequest(deviceNumber, 'POST', `/session/${currentSessionId}/wda/tap`, {
    x: pointX,
    y: pointY,
  });

  if (res.status !== 200) {
    throw new Error(`Tap failed with HTTP ${res.status}: ${JSON.stringify(res.body)}`);
  }
  return { ok: true, x: pointX, y: pointY };
}

async function controlDevice(input) {
  if (!currentSessionId) {
    await syncWdaSessionAndSettings(currentDeviceNumber);
  }
  if (!currentSessionId) throw new Error('No active WDA session');
  const base = `/session/${currentSessionId}`;

  if (input.kind === 'home') {
    await sendWdaRequest(currentDeviceNumber, 'POST', '/wda/homescreen');
    return { ok: true, action: 'home' };
  }
  if (input.kind === 'activate') {
    const bundleId = input.bundleId || 'com.apple.mobilesafari';
    await sendWdaRequest(currentDeviceNumber, 'POST', `${base}/wda/apps/activate`, { bundleId });
    return { ok: true, action: 'activate', bundleId };
  }

  const executeAction = async () => {
    if (input.kind === 'type') {
      if (typeof input.text !== 'string' || !input.text.length || input.text.length > 2000) throw new Error('Invalid text');
      const active = await sendWdaRequest(currentDeviceNumber, 'GET', base + '/element/active');
      const value = active.body.value;
      const id = value?.['element-6066-11e4-a52e-4f735466cecf'] || value?.ELEMENT;
      if (!id) throw new Error('Tap an editable field on the phone first');
      await sendWdaRequest(currentDeviceNumber, 'POST', base + '/element/' + encodeURIComponent(id) + '/value', {value:[input.text]});
      return { ok: true, typed: input.text.length };
    } else {
      if (input.kind === 'tap') return tapDevice(currentDeviceNumber, input.x, input.y);
      if (input.kind === 'scroll') {
        // Natural, controlled step scroll without high-velocity fling
        const delta = Number.isFinite(input.delta) ? Math.round(input.delta) : 60;
        const startY = 460;
        const endY = Math.max(120, Math.min(760, startY - delta));
        // Critical iOS physics: move smoothly over 160ms, then hold for 40ms before release.
        // Zero release velocity = zero inertia fling!
        await sendWdaRequest(currentDeviceNumber, 'POST', base + '/actions', {
          actions: [{
            type: 'pointer',
            id: 'finger1',
            parameters: { pointerType: 'touch' },
            actions: [
              { type: 'pointerMove', duration: 0, x: 195, y: startY },
              { type: 'pointerDown', button: 0 },
              { type: 'pointerMove', duration: 160, x: 195, y: endY },
              { type: 'pause', duration: 40 },
              { type: 'pointerUp', button: 0 },
            ],
          }],
        });
        return { ok: true, scroll: delta };
      }
      if (input.kind === 'swipe') {
        const duration = Number.isFinite(input.duration) && input.duration >= 60 && input.duration <= 1000
          ? Math.round(input.duration)
          : 200;
        const pause = input.settle ? 40 : 0;
        const subActions = [
          { type: 'pointerMove', duration: 0, x: input.x, y: input.y },
          { type: 'pointerDown', button: 0 },
          { type: 'pointerMove', duration, x: input.x2, y: input.y2 },
        ];
        if (pause > 0) subActions.push({ type: 'pause', duration: pause });
        subActions.push({ type: 'pointerUp', button: 0 });
        await sendWdaRequest(currentDeviceNumber, 'POST', base + '/actions', {
          actions: [{
            type: 'pointer',
            id: 'finger1',
            parameters: { pointerType: 'touch' },
            actions: subActions,
          }],
        });
        return { ok: true, swipe: [input.x, input.y, input.x2, input.y2] };
      }
      throw new Error('Unknown control');
    }
  };

  try {
    return await executeAction();
  } catch (err) {
    if (err.message && err.message.includes('not running, possibly crashed')) {
      console.warn('[AntiFan Stream] App not in foreground, auto-activating Safari and retrying...');
      await sendWdaRequest(currentDeviceNumber, 'POST', `${base}/wda/apps/activate`, { bundleId: 'com.apple.mobilesafari' });
      await new Promise(r => setTimeout(r, 400));
      return await executeAction();
    }
    throw err;
  }
}
let controlBusy = false;
const HTML = `<!DOCTYPE html>
<html lang="vi">
<head>
  <meta charset="UTF-8">
  <title>AntiFan Live iPhone Stream</title>
  <style>
    * { box-sizing: border-box; margin: 0; padding: 0; }
    html, body {
      width: 100vw;
      height: 100vh;
      overflow: hidden;
      background: #090d16;
      color: #f8fafc;
      font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
    }
    body {
      display: flex;
      flex-direction: column;
      align-items: center;
      padding: 10px 16px 12px;
      gap: 8px;
    }
    header {
      flex-shrink: 0;
      display: flex;
      align-items: center;
      justify-content: space-between;
      width: 100%;
      max-width: 800px;
      padding: 4px 8px;
    }
    .header-left {
      display: flex;
      align-items: center;
      gap: 8px;
    }
    h1 {
      font-size: 14px;
      font-weight: 600;
      color: #38bdf8;
      display: flex;
      align-items: center;
      gap: 6px;
    }
    .badge {
      display: inline-block;
      width: 8px;
      height: 8px;
      background: #22c55e;
      border-radius: 50%;
      box-shadow: 0 0 8px #22c55e;
    }
    .status {
      font-size: 11px;
      color: #94a3b8;
    }
    .hints {
      display: flex;
      gap: 8px;
      font-size: 11px;
      color: #64748b;
    }
    .pill {
      background: #1e293b;
      padding: 2px 8px;
      border-radius: 999px;
      border: 1px solid #334155;
    }
    /* Main Centered Stage that always fits viewport */
    .stream-stage {
      flex: 1;
      min-height: 0;
      width: 100%;
      display: flex;
      justify-content: center;
      align-items: center;
    }
    .phone-wrapper {
      position: relative;
      height: 100%;
      max-height: calc(100vh - 65px);
      aspect-ratio: 390 / 844;
      background: #1e293b;
      border: 3px solid #334155;
      border-radius: 38px;
      user-select: none;
      display: flex;
      justify-content: center;
      align-items: center;
      overflow: hidden;
    }
    .phone-screen {
      width: 100%;
      height: 100%;
      object-fit: contain;
      display: block;
      background: #000;
      user-select: none;
      touch-action: none;
      border-radius: 32px;
    }
    .tap-indicator {
      position: absolute;
      width: 22px;
      height: 22px;
      border: 2px solid #38bdf8;
      border-radius: 50%;
      background: rgba(56, 189, 248, 0.4);
      transform: translate(-50%, -50%);
      pointer-events: none;
      animation: ripple 0.35s ease-out forwards;
    }
    @keyframes ripple {
      0% { transform: translate(-50%, -50%) scale(0.4); opacity: 1; }
      100% { transform: translate(-50%, -50%) scale(1.5); opacity: 0; }
    }
    .nav-btn {
      background: #1e293b;
      color: #94a3b8;
      border: 1px solid #334155;
      padding: 4px 10px;
      border-radius: 6px;
      font-size: 12px;
      cursor: pointer;
      transition: all 0.15s;
      display: flex;
      align-items: center;
      gap: 4px;
    }
    .nav-btn:hover { background: #334155; color: #f8fafc; border-color: #475569; }
    .nav-btn:active { transform: scale(0.96); }
  </style>
</head>
<body>
  <header>
    <div class="header-left">
      <h1><span class="badge"></span> iPhone 13 Live Cast</h1>
      <span class="status" id="controlStatus" role="status">USB WebSocket</span>
      <span class="pill" id="fpsDisplay" style="color: #4ade80; font-weight: bold;">-- FPS</span>
    </div>
    <div class="hints">
      <button class="nav-btn" id="btnHome" title="Phím Home">🏠 Home</button>
      <button class="nav-btn" id="btnSafari" title="Mở Safari">🧭 Safari</button>
      <button class="nav-btn" id="btnChrome" title="Mở Chrome">🌐 Chrome</button>
      <input id="textInput" aria-label="Văn bản gửi tới iPhone" placeholder="Chạm ô nhập trên máy rồi gõ chữ...">
      <button id="sendText">Gửi</button>
    </div>
  </header>

  <div class="stream-stage">
    <div class="phone-wrapper" id="phoneContainer">
      <canvas class="phone-screen" id="screenCanvas" width="386" height="836"></canvas>
    </div>
  </div>
  <script>
    const canvas = document.getElementById('screenCanvas');
    const ctx = canvas.getContext('2d', { alpha: false, desynchronized: true });
    const fpsDisplay = document.getElementById('fpsDisplay');
    const status = document.getElementById('controlStatus');

    // Zero-latency WebSocket frame receiver with GPU canvas decoding
    const wsProto = location.protocol === 'https:' ? 'wss:' : 'ws:';
    const ws = new WebSocket(wsProto + '//' + location.host + '/ws-stream');
    ws.binaryType = 'arraybuffer';
    let frameCount = 0;
    let lastFpsTime = performance.now();
    let pendingBlob = null;
    let isRendering = false;

    async function renderFrame() {
      if (pendingBlob) {
        const blob = pendingBlob;
        pendingBlob = null;
        try {
          const bitmap = await createImageBitmap(blob);
          ctx.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
          bitmap.close();
        } catch (err) {}
      }
      if (pendingBlob) {
        requestAnimationFrame(renderFrame);
      } else {
        isRendering = false;
      }
    }

    ws.onmessage = (event) => {
      frameCount++;
      const now = performance.now();
      if (now - lastFpsTime >= 1000) {
        const fps = Math.round((frameCount * 1000) / (now - lastFpsTime));
        fpsDisplay.textContent = fps + ' FPS';
        frameCount = 0;
        lastFpsTime = now;
      }

      pendingBlob = new Blob([event.data], { type: 'image/jpeg' });
      if (!isRendering) {
        isRendering = true;
        requestAnimationFrame(renderFrame);
      }
    };
    ws.onopen = () => { status.textContent = 'Live Connected'; };
    ws.onclose = () => { status.textContent = 'Disconnected'; fpsDisplay.textContent = '0 FPS'; };

    function point(e) {
      const rect = canvas.getBoundingClientRect();
      const actualWidth = rect.width;
      const actualHeight = rect.height;
      if (!actualWidth || !actualHeight) return null;
      const clickX = e.clientX - rect.left;
      const clickY = e.clientY - rect.top;
      if (clickX < 0 || clickX > actualWidth || clickY < 0 || clickY > actualHeight) return null;
      return {
        x: Math.min(389, Math.max(0, Math.round(clickX / actualWidth * 390))),
        y: Math.min(843, Math.max(0, Math.round(clickY / actualHeight * 844))),
      };
    }

    let busy = false, down = null;
    async function send(input) {
      if (busy) return;
      busy = true;
      const started = performance.now();
      try {
        const r = await fetch('/control', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(input),
        });
        const result = await r.json();
        if (!r.ok || !result.success) throw new Error(result.error || 'Control failed');
        status.textContent = input.kind + ' OK · ' + Math.round(performance.now() - started) + ' ms';
      } catch (e) {
        status.textContent = e.message;
      } finally {
        busy = false;
      }
    }

    let downTime = 0;
    canvas.draggable = false;
    canvas.onpointerdown = e => {
      if (e.button !== 0 || busy) return;
      down = point(e);
      downTime = performance.now();
      if (down) {
        canvas.setPointerCapture(e.pointerId);
        const indicator = document.createElement('div');
        indicator.className = 'tap-indicator';
        const cRect = container.getBoundingClientRect();
        indicator.style.left = (e.clientX - cRect.left) + 'px';
        indicator.style.top = (e.clientY - cRect.top) + 'px';
        container.appendChild(indicator);
        setTimeout(() => indicator.remove(), 450);
      }
    };
    canvas.onpointercancel = () => { down = null; };
    canvas.onpointerup = e => {
      const start = down; down = null;
      const end = point(e);
      if (!start || !end) return;
      const dist = Math.hypot(end.x - start.x, end.y - start.y);
      if (dist > 8) {
        const elapsed = performance.now() - downTime;
        const duration = Math.min(450, Math.max(120, Math.round(elapsed)));
        const settle = elapsed > 200;
        send({ kind: 'swipe', ...start, x2: end.x, y2: end.y, duration, settle });
      } else {
        send({ kind: 'tap', ...end });
      }
    };

    // Natural, gentle wheel scrolling with throttle and anti-fling
    let wheelAccum = 0;
    let wheelTimer = null;
    canvas.addEventListener('wheel', e => {
      e.preventDefault();
      wheelAccum += e.deltaY;
      if (wheelTimer) return;
      wheelTimer = setTimeout(() => {
        wheelTimer = null;
        if (Math.abs(wheelAccum) < 5) return;
        const dir = Math.sign(wheelAccum);
        // Step scroll: 60-80px per wheel notch (smooth & contained)
        const delta = dir * Math.min(90, Math.max(50, Math.round(Math.abs(wheelAccum) * 0.5)));
        wheelAccum = 0;
        send({ kind: 'scroll', delta });
      }, 70);
    }, { passive: false });

    document.getElementById('sendText').onclick = () => send({ kind: 'type', text: document.getElementById('textInput').value });
    document.getElementById('btnHome').onclick = () => send({ kind: 'home' });
    document.getElementById('btnSafari').onclick = () => send({ kind: 'activate', bundleId: 'com.apple.mobilesafari' });
    document.getElementById('btnChrome').onclick = () => send({ kind: 'activate', bundleId: 'com.google.chrome.ios' });
  </script>
</body>
</html>`;

async function startServer() {
  const dev = await getDevice();
  currentDeviceNumber = dev.deviceNumber;
  console.log(`[AntiFan Stream] Found iPhone (Device ID: ${dev.deviceId}, Number: ${dev.deviceNumber})`);

  // Forward device port 9100 to 127.0.0.1:9100
  try {
    mjpegForwarder = await createUsbmuxPortForwarder({
      deviceNumber: currentDeviceNumber,
      devicePort: 9100,
      localHost: '127.0.0.1',
      localPort: 9100
    });
    console.log(`[AntiFan Stream] MJPEG Forwarder active: 127.0.0.1:9100 -> device ${currentDeviceNumber}:9100`);
  } catch (err) {
    console.warn('[AntiFan Stream] Forwarder already active or failed:', err.message);
  }

  // Initial session sync and high-FPS tuning
  await syncWdaSessionAndSettings(currentDeviceNumber);


  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url, 'http://127.0.0.1:3399');

    if (url.pathname === '/') {
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      res.end(HTML);
      return;
    }

    if (url.pathname === '/control' && req.method === 'POST') {
      if (req.headers.origin !== 'http://127.0.0.1:3399' || !req.headers['content-type']?.startsWith('application/json')) {
        res.writeHead(403);res.end();return;
      }
      if (controlBusy) {res.writeHead(409);res.end(JSON.stringify({error:'Device busy'}));return;}
      let body = '';
      req.on('data', chunk => {body += chunk;if(body.length>16384)req.destroy();});
      req.on('end', async () => {
        if (controlBusy) {res.writeHead(409);res.end(JSON.stringify({error:'Device busy'}));return;}
        controlBusy = true;
        try {
          const result = await controlDevice(JSON.parse(body));
          res.writeHead(200, {'Content-Type':'application/json'});
          res.end(JSON.stringify({success:true,...result}));
        } catch (e) {
          console.error('[AntiFan Stream] Tap error:', e.message);
          res.writeHead(500, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ success: false, error: e.message }));
        } finally {
          controlBusy = false;
        }
      });
      return;
    }

    res.writeHead(404);
    res.end('Not Found');
  });

  // Start persistent MJPEG frame ingestion and WebSocket broadcasting
  const wsClients = new Set();
  const wss = new WebSocketServer({ server, path: '/ws-stream' });
  wss.on('connection', ws => {
    wsClients.add(ws);
    ws.on('close', () => wsClients.delete(ws));
    ws.on('error', () => wsClients.delete(ws));
  });

  function startFrameIngestion() {
    const streamReq = http.get('http://127.0.0.1:9100/', res => {
      let buf = Buffer.alloc(0);
      res.on('data', chunk => {
        buf = Buffer.concat([buf, chunk]);
        let startIdx, endIdx;
        while ((startIdx = buf.indexOf(Buffer.from([0xFF, 0xD8]))) !== -1) {
          endIdx = buf.indexOf(Buffer.from([0xFF, 0xD9]), startIdx);
          if (endIdx === -1) break;
          const frame = buf.subarray(startIdx, endIdx + 2);
          buf = buf.subarray(endIdx + 2);

          // Broadcast only to non-buffered clients (zero network queuing / true real-time)
          for (const client of wsClients) {
            if (client.readyState === 1 && client.bufferedAmount === 0) {
              client.send(frame);
            }
          }
        }
      });
      res.on('end', () => setTimeout(startFrameIngestion, 1000));
      res.on('error', () => setTimeout(startFrameIngestion, 1000));
    });
    streamReq.on('error', () => setTimeout(startFrameIngestion, 1000));
  }
  startFrameIngestion();

  server.listen(3399, '127.0.0.1', () => {
    console.log('[AntiFan Stream] Web UI running at http://127.0.0.1:3399/');
  });
}

startServer().catch(err => {
  console.error('[AntiFan Stream] Startup failed:', err.message);
  process.exit(1);
});
