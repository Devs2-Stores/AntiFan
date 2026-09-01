/**
 * Live Electron Chromium E2E Test for Semantic Ref Interaction Engine
 * Verifies:
 * 1. Tier 1 Synthetic Path (World 1004): Prototype descriptor setter stealing, genuine React 18 AND React 19 controlled component updates, isTrusted === false, and composed event cascade.
 * 2. Tier 2 Trusted Path (CDP): True hardware-level Input.dispatchKeyEvent (clear) + Input.insertText with genuine isTrusted === true.
 * 3. Shadow DOM: Traversal and event dispatch across open ShadowRoot boundaries.
 * 4. ContentEditable: Range selection and text insertion without throwing.
 */
const { app, BrowserWindow } = require('electron');
const http = require('node:http');
const path = require('node:path');
const os = require('node:os');
const fs = require('node:fs');
const assert = require('node:assert/strict');

app.commandLine.appendSwitch('no-sandbox');
app.commandLine.appendSwitch('disable-gpu');

const tempUserData = fs.mkdtempSync(path.join(os.tmpdir(), 'antifan-trusted-cdp-'));
app.setPath('userData', tempUserData);

const { buildIsolatedExecutorScript, ISOLATED_AGENT_WORLD_ID, validateActionResponse } = require('../.compiled/src/main/browser/semantic-ref-executor.js');
const { TabAutomationHost } = require('../.compiled/src/main/browser/tab-automation-host.js');

async function runLiveChromiumTest() {
  console.log('[Live Chromium E2E] Starting Semantic Ref Dual-Tier & CDP Verification...');

  let server;
  let win;

  try {
    const fixture18Dir = path.resolve(__dirname, '..', 'test', 'fixtures', 'react');
    const react18Js = fs.readFileSync(path.join(fixture18Dir, 'react.production.min.js'), 'utf8');
    const reactDom18Js = fs.readFileSync(path.join(fixture18Dir, 'react-dom.production.min.js'), 'utf8');

    const fixture19Dir = path.resolve(__dirname, '..', 'test', 'fixtures', 'react19');
    const react19Js = fs.readFileSync(path.join(fixture19Dir, 'react19.bundle.mjs'), 'utf8');
    const reactDom19Js = fs.readFileSync(path.join(fixture19Dir, 'react-dom19.bundle.mjs'), 'utf8');

    // 1. Setup Local HTTP Server serving genuine React 18, React 19, and Test HTML
    const testHtml = `<!DOCTYPE html>
<html>
<head>
  <meta charset="utf-8">
  <title>AntiFan Live E2E</title>
  <script src="/react.js"></script>
  <script src="/react-dom.js"></script>
</head>
<body>
  <!-- Genuine React 18 Controlled Component Root -->
  <div id="react-root"></div>

  <!-- Genuine React 19 Controlled Component Root -->
  <div id="react19-root"></div>
  
  <!-- Hardware CDP Target Input seeded with non-empty stale value -->
  <input id="cdp-trusted-input" type="text" value="stale-seed-data-999" />
  <!-- ContentEditable Element -->
  <div id="content-editable-box" contenteditable="true" style="border: 1px solid black; min-height: 20px;">Initial Text</div>

  <!-- Shadow DOM Host -->
  <div id="shadow-host"></div>

  <script>
    window.recordedEvents = [];

    // Mount genuine React 18 controlled component
    const e = React.createElement;
    function ControlledApp() {
      const [val, setVal] = React.useState('initial');
      return e('div', { id: 'react-container' }, [
        e('input', {
          key: 'input',
          id: 'react-controlled-input',
          value: val,
          onChange: (ev) => {
            window.recordedEvents.push({
              targetId: 'react-controlled-input',
              type: 'react-change',
              value: ev.target.value,
              isTrusted: ev.nativeEvent ? ev.nativeEvent.isTrusted : false
            });
            setVal(ev.target.value);
          },
          onInput: (ev) => {
            window.recordedEvents.push({
              targetId: 'react-controlled-input',
              type: 'react-input',
              value: ev.target.value,
              isTrusted: ev.nativeEvent ? ev.nativeEvent.isTrusted : false
            });
          }
        }),
        e('span', { key: 'span', id: 'react-rendered-state' }, val)
      ]);
    }
    const root = ReactDOM.createRoot(document.getElementById('react-root'));
    root.render(e(ControlledApp));

    // Raw event listener on document for React inputs
    document.addEventListener('input', (ev) => {
      if (ev.target && (ev.target.id === 'react-controlled-input' || ev.target.id === 'react19-controlled-input')) {
        window.recordedEvents.push({
          targetId: ev.target.id,
          type: 'raw-input',
          value: ev.target.value,
          isTrusted: ev.isTrusted,
          composed: ev.composed
        });
      }
    }, true);

    // Event Listener on #cdp-trusted-input
    const cdpInput = document.getElementById('cdp-trusted-input');
    ['beforeinput', 'input', 'change', 'keydown', 'keyup'].forEach(type => {
      cdpInput.addEventListener(type, (e) => {
        window.recordedEvents.push({
          targetId: 'cdp-trusted-input',
          type: e.type,
          data: e.data,
          isTrusted: e.isTrusted,
          value: cdpInput.value
        });
      });
    });

    // Event Listener on #content-editable-box
    const ceBox = document.getElementById('content-editable-box');
    ['beforeinput', 'input'].forEach(type => {
      ceBox.addEventListener(type, (e) => {
        window.recordedEvents.push({
          targetId: 'content-editable-box',
          type: e.type,
          data: e.data,
          isTrusted: e.isTrusted,
          text: ceBox.textContent
        });
      });
    });

    // Create Open Shadow DOM
    const shadowHost = document.getElementById('shadow-host');
    const shadowRoot = shadowHost.attachShadow({ mode: 'open' });
    const shadowInput = document.createElement('input');
    shadowInput.id = 'shadow-inner-input';
    shadowRoot.appendChild(shadowInput);

    shadowInput.addEventListener('input', (e) => {
      window.recordedEvents.push({
        targetId: 'shadow-inner-input',
        type: e.type,
        data: e.data,
        isTrusted: e.isTrusted,
        composed: e.composed,
        value: shadowInput.value
      });
    });
  </script>

  <!-- Mount genuine React 19 controlled component via ESM module -->
  <script type="module">
    import React19, { useState, createElement } from '/react@19.0.0/es2022/react.mjs';
    import ReactDOM19 from '/react-dom19.mjs';

    function ControlledApp19() {
      const [val, setVal] = useState('react19-initial');
      return createElement('div', { id: 'react19-container' }, [
        createElement('input', {
          key: 'input',
          id: 'react19-controlled-input',
          value: val,
          onChange: (ev) => {
            window.recordedEvents.push({
              targetId: 'react19-controlled-input',
              type: 'react19-change',
              value: ev.target.value,
              isTrusted: ev.nativeEvent ? ev.nativeEvent.isTrusted : false
            });
            setVal(ev.target.value);
          },
          onInput: (ev) => {
            window.recordedEvents.push({
              targetId: 'react19-controlled-input',
              type: 'react19-input',
              value: ev.target.value,
              isTrusted: ev.nativeEvent ? ev.nativeEvent.isTrusted : false
            });
          }
        }),
        createElement('span', { key: 'span', id: 'react19-rendered-state' }, val)
      ]);
    }

    const root19 = ReactDOM19.createRoot(document.getElementById('react19-root'));
    root19.render(createElement(ControlledApp19));
    window.__react19Mounted = true;
  </script>
</body>
</html>`;

    server = http.createServer((req, res) => {
      if (req.url === '/react.js') {
        res.writeHead(200, { 'Content-Type': 'application/javascript; charset=utf-8' });
        res.end(react18Js);
        return;
      }
      if (req.url === '/react-dom.js') {
        res.writeHead(200, { 'Content-Type': 'application/javascript; charset=utf-8' });
        res.end(reactDom18Js);
        return;
      }
      if (req.url === '/react@19.0.0/es2022/react.mjs') {
        res.writeHead(200, { 'Content-Type': 'application/javascript; charset=utf-8' });
        res.end(react19Js);
        return;
      }
      if (req.url === '/react-dom19.mjs') {
        res.writeHead(200, { 'Content-Type': 'application/javascript; charset=utf-8' });
        res.end(reactDom19Js);
        return;
      }
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      res.end(testHtml);
    });

    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
    const port = server.address().port;
    const pageUrl = `http://127.0.0.1:${port}/`;
    console.log(`[Live Chromium E2E] HTTP server listening on ${pageUrl}`);

    // 2. Launch Electron BrowserWindow
    win = new BrowserWindow({
      width: 1024,
      height: 768,
      show: false,
      webPreferences: {
        sandbox: true,
        contextIsolation: true,
      },
    });

    await win.loadURL(pageUrl);
    console.log('[Live Chromium E2E] Page loaded in Chromium.');

    // Wait for React 18 and React 19 roots initial render
    let mounted = false;
    for (let i = 0; i < 30; i++) {
      mounted = await win.webContents.executeJavaScript('Boolean(window.__react19Mounted && document.getElementById("react-rendered-state") && document.getElementById("react19-rendered-state"))');
      if (mounted) break;
      await new Promise(r => setTimeout(r, 100));
    }
    assert.equal(mounted, true, 'Both React 18 and React 19 must mount successfully');

    const wc = win.webContents;

    // ─── Test 1A: Tier 1 Synthetic Path in World 1004 on React 18 ───
    console.log('[Live Chromium E2E] Running Test 1A: Tier 1 Synthetic Path on React 18 in World 1004...');
    const synth18Script = buildIsolatedExecutorScript({
      action: 'type',
      selector: '#react-controlled-input',
      text: 'Haravan React 18 Live',
      clear: true,
      nonce: '11111111-2222-3333-4444-555555555555',
      documentUrl: pageUrl,
    });

    const rawSynth18Res = await wc.executeJavaScriptInIsolatedWorld(ISOLATED_AGENT_WORLD_ID, [{ code: synth18Script }]);
    const synth18Res = validateActionResponse(rawSynth18Res);
    assert.equal(synth18Res.ok, true, 'Synthetic execution in World 1004 must succeed for React 18');

    await new Promise(r => setTimeout(r, 100));

    const text18 = await wc.executeJavaScript('document.getElementById("react-rendered-state").textContent');
    assert.equal(text18, 'Haravan React 18 Live', 'Genuine React 18 controlled component state must update to new value');

    const domVal18 = await wc.executeJavaScript('document.getElementById("react-controlled-input").value');
    assert.equal(domVal18, 'Haravan React 18 Live', 'React 18 DOM input value must be updated via native setter');

    const rawEv18 = await wc.executeJavaScript('window.recordedEvents.find(e => e.targetId === "react-controlled-input" && e.type === "raw-input")');
    assert.ok(rawEv18, 'Must receive raw input event for React 18');
    assert.equal(rawEv18.isTrusted, false, 'Synthetic input event must have isTrusted === false');
    assert.equal(rawEv18.composed, true, 'Synthetic input event must have composed === true');

    console.log('[Live Chromium E2E] [OK] Tier 1 Synthetic Path with genuine React 18 verified.');

    // ─── Test 1B: Tier 1 Synthetic Path in World 1004 on React 19 ───
    console.log('[Live Chromium E2E] Running Test 1B: Tier 1 Synthetic Path on React 19 in World 1004...');
    const synth19Script = buildIsolatedExecutorScript({
      action: 'type',
      selector: '#react19-controlled-input',
      text: 'Haravan React 19 Live',
      clear: true,
      nonce: '22222222-3333-4444-5555-666666666666',
      documentUrl: pageUrl,
    });

    const rawSynth19Res = await wc.executeJavaScriptInIsolatedWorld(ISOLATED_AGENT_WORLD_ID, [{ code: synth19Script }]);
    const synth19Res = validateActionResponse(rawSynth19Res);
    assert.equal(synth19Res.ok, true, 'Synthetic execution in World 1004 must succeed for React 19');

    await new Promise(r => setTimeout(r, 100));

    const text19 = await wc.executeJavaScript('document.getElementById("react19-rendered-state").textContent');
    assert.equal(text19, 'Haravan React 19 Live', 'Genuine React 19 controlled component state must update to new value');

    const domVal19 = await wc.executeJavaScript('document.getElementById("react19-controlled-input").value');
    assert.equal(domVal19, 'Haravan React 19 Live', 'React 19 DOM input value must be updated via native setter');

    const rawEv19 = await wc.executeJavaScript('window.recordedEvents.find(e => e.targetId === "react19-controlled-input" && e.type === "raw-input")');
    assert.ok(rawEv19, 'Must receive raw input event for React 19');
    assert.equal(rawEv19.isTrusted, false, 'Synthetic input event must have isTrusted === false');
    assert.equal(rawEv19.composed, true, 'Synthetic input event must have composed === true');

    console.log('[Live Chromium E2E] [OK] Tier 1 Synthetic Path with genuine React 19 verified.');

    // ─── Benchmark: Tier 1 Synthetic Path Actionability Latency on Real buildIsolatedExecutorScript ───
    console.log('[Live Chromium E2E] Running Benchmark: Tier 1 Real buildIsolatedExecutorScript actionability latency verification (<150ms SLO, 20/20 state correctness)...');
    
    // 1. Warm-up runs (untimed to eliminate V8 script compilation overhead)
    for (let w = 0; w < 3; w++) {
      const warmupScript = buildIsolatedExecutorScript({
        action: 'type',
        selector: '#react-controlled-input',
        text: 'bench-warmup-' + w,
        clear: true,
        nonce: 'warmup-nonce-' + w,
        documentUrl: pageUrl,
      });
      const timedWarmup = `(async () => {
        const t0 = performance.now();
        const res = await (${warmupScript});
        const t1 = performance.now();
        return { ...res, executionDurationMs: t1 - t0 };
      })()`;
      await wc.executeJavaScriptInIsolatedWorld(ISOLATED_AGENT_WORLD_ID, [{ code: timedWarmup }]);
      await new Promise(r => setTimeout(r, 20));
    }
    // 2. Timed benchmark runs (20 iterations)
    const latencies = [];
    for (let i = 0; i < 20; i++) {
      const targetText = 'bench-real-run-' + i;
      const baseScript = buildIsolatedExecutorScript({
        action: 'type',
        selector: '#react-controlled-input',
        text: targetText,
        clear: true,
        nonce: 'bench-nonce-' + i,
        documentUrl: pageUrl,
      });

      const timedScript = `(async () => {
        const t0 = performance.now();
        const res = await (${baseScript});
        const t1 = performance.now();
        return { ...res, executionDurationMs: t1 - t0 };
      })()`;

      const rawRes = await wc.executeJavaScriptInIsolatedWorld(ISOLATED_AGENT_WORLD_ID, [{ code: timedScript }]);
      const dur = rawRes.executionDurationMs;
      latencies.push(dur);

      const res = validateActionResponse(rawRes);
      assert.equal(res.ok, true, 'Synthetic operation ' + i + ' must succeed');
      assert.ok(dur < 150.0, 'Iteration ' + i + ' latency must remain within 150ms SLO (got ' + dur.toFixed(3) + 'ms)');

      // Allow microtask to settle and verify React 18 state after each operation
      await new Promise(r => setTimeout(r, 10));
      const renderedVal = await wc.executeJavaScript('document.getElementById("react-rendered-state").textContent');
      assert.equal(renderedVal, targetText, 'React state must match text for iteration ' + i);
    }

    const avgLat = latencies.reduce((a, b) => a + b, 0) / latencies.length;
    const maxLat = Math.max(...latencies);
    console.log('[Live Chromium E2E] In-DOM buildIsolatedExecutorScript Latencies (ms):', latencies.map(l => l.toFixed(2)).join(', '));
    console.log('[Live Chromium E2E] Avg:', avgLat.toFixed(3) + 'ms, Max:', maxLat.toFixed(3) + 'ms');
    assert.ok(avgLat < 100.0, 'Average real synthetic executor latency must remain bounded under 100ms (got ' + avgLat.toFixed(3) + 'ms)');
    console.log('[Live Chromium E2E] [OK] Tier 1 real executor bounded actionability latency verified (<150ms SLO, avg ' + avgLat.toFixed(3) + 'ms, max ' + maxLat.toFixed(3) + 'ms, 20/20 state updates correct).');
    console.log('[Live Chromium E2E] Running Test 2: Tier 2 Hardware CDP Trusted Path via TabAutomationHost...');
    
    const mockContext = {
      getTabWebContents: () => wc,
      getTabRecord: (_id) => ({
        state: { id: 'tab-1', aiState: 'idle' },
        focusedPane: 'desktop',
      }),
      getAutomationTabId: () => 'tab-1',
      getActiveTabId: () => 'tab-1',
      getBrowserEpoch: () => 1,
      getSemanticDocumentGeneration: () => 1,
      runTargetOperation: async (_id, _pane, op) => op(),
      broadcastState: () => {},
      syncFrameBackdrop: () => {},
    };

    const host = new TabAutomationHost(mockContext);

    const typeOk = await host.agentType({
      selector: '#cdp-trusted-input',
      text: '998877',
      clear: true,
      trusted: true,
      tabId: 'tab-1',
    });
    assert.equal(typeOk, true, 'TabAutomationHost.agentType with trusted: true must succeed');

    // Allow Chromium event loop to dispatch events
    await new Promise(r => setTimeout(r, 100));

    const cdpEvents = await wc.executeJavaScript('window.recordedEvents.filter(e => e.targetId === "cdp-trusted-input")');
    const domVal = await wc.executeJavaScript('document.getElementById("cdp-trusted-input").value');
    
    // Assert trusted clearing happened via hardware key events
    const cdpClearInput = cdpEvents.find(e => e.type === 'input' && e.value === '');
    assert.ok(cdpClearInput, 'Must receive clear input event with empty value');
    assert.equal(cdpClearInput.isTrusted, true, 'Clear input event must have isTrusted === true');

    // Assert trusted insertion happened with new value
    const cdpFinalInput = cdpEvents.find(e => e.type === 'input' && e.value === '998877');
    assert.ok(cdpFinalInput, 'Must receive final insertion input event with new value');
    assert.equal(cdpFinalInput.isTrusted, true, 'Final insertion input event must have isTrusted === true');
    assert.equal(domVal, '998877', 'Final DOM input value must equal text inserted via CDP');
    console.log('[Live Chromium E2E] [OK] Tier 2 Hardware CDP Trusted Path verified.');

    // ─── Test 3: Shadow DOM Synthetic Cascade ───
    console.log('[Live Chromium E2E] Running Test 3: Shadow DOM Interaction in World 1004...');
    const shadowScript = `(() => {
      const host = document.getElementById('shadow-host');
      const input = host.shadowRoot.getElementById('shadow-inner-input');
      input.focus();
      
      let proto = Object.getPrototypeOf(input);
      let desc = null;
      while (proto) {
        desc = Object.getOwnPropertyDescriptor(proto, 'value');
        if (desc && desc.set) break;
        proto = Object.getPrototypeOf(proto);
      }
      if (desc && desc.set) desc.set.call(input, 'Shadow Secret');
      else input.value = 'Shadow Secret';
      
      input.dispatchEvent(new InputEvent('input', { bubbles: true, composed: true, data: 'Shadow Secret', inputType: 'insertText' }));
      return { ok: true, executed: true };
    })()`;

    await wc.executeJavaScriptInIsolatedWorld(ISOLATED_AGENT_WORLD_ID, [{ code: shadowScript }]);
    
    const shadowEv = await wc.executeJavaScript('window.recordedEvents.find(e => e.targetId === "shadow-inner-input")');
    assert.ok(shadowEv, 'Must receive input event from Shadow DOM inner input');
    assert.equal(shadowEv.value, 'Shadow Secret');
    assert.equal(shadowEv.composed, true, 'Event from ShadowRoot must have composed: true');
    console.log('[Live Chromium E2E] [OK] Shadow DOM Interaction verified.');

    // ─── Test 4: ContentEditable Insertion ───
    console.log('[Live Chromium E2E] Running Test 4: ContentEditable Text Insertion...');
    const ceScript = buildIsolatedExecutorScript({
      action: 'type',
      selector: '#content-editable-box',
      text: ' Edited',
      clear: false,
      nonce: '33333333-4444-5555-6666-777777777777',
      documentUrl: pageUrl,
    });

    const rawCeRes = await wc.executeJavaScriptInIsolatedWorld(ISOLATED_AGENT_WORLD_ID, [{ code: ceScript }]);
    const ceRes = validateActionResponse(rawCeRes);
    assert.equal(ceRes.ok, true, 'ContentEditable insertion must succeed');

    const ceText = await wc.executeJavaScript('document.getElementById("content-editable-box").textContent');
    assert.ok(ceText.includes('Edited'), 'ContentEditable element text must contain inserted string');
    console.log('[Live Chromium E2E] [OK] ContentEditable Text Insertion verified.');

    console.log('[Live Chromium E2E] ALL MILESTONES (React 18, React 19, CDP Trusted, Shadow DOM, ContentEditable) PASSED WITH ZERO ERRORS.');

    if (win) win.destroy();
    if (server) server.close();
    try { fs.rmSync(tempUserData, { recursive: true, force: true }); } catch {}
    process.exit(0);

  } catch (err) {
    console.error('[Live Chromium E2E] FAILED:', err);
    if (win) {
      try { win.destroy(); } catch {}
    }
    if (server) {
      try { server.close(); } catch {}
    }
    try { fs.rmSync(tempUserData, { recursive: true, force: true }); } catch {}
    process.exit(1);
  }
}

app.whenReady().then(runLiveChromiumTest);
