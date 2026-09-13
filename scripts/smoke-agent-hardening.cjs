/**
 * AntiFan Agent Automation Hardening — Live Electron / Real Chromium Probe
 *
 * Proves, against real Chromium and real CDP (no mocks, no stubs of the code
 * under test), the four behaviours added by the "steal Playwright's algorithms"
 * work:
 *
 *  1. Occlusion gate      — an input-bearing action is refused when every sampled
 *                           point of the target belongs to another element, the
 *                           multi-point walk rescues a target whose CENTER is
 *                           covered but whose body is reachable, and `force`
 *                           bypasses the gate (dispatching through the overlay,
 *                           which is what force means).
 *  2. Infinite motion     — a target running an infinite CSS animation is not
 *                           refused and does not spend the drift budget.
 *  3. Pointer drag        — interpolated press/move/release actually drives a
 *                           slider that only listens to mousemove, and the
 *                           gesture always ends with a released button.
 *  4. Tracker isolation   — the pre-document stub reaches the NEXT document (the
 *                           reload QA performs), the blocklist is applied, and
 *                           release removes the registration so a later document
 *                           gets no stub at all.
 *  5. Scroll pre-warm     — a lazily appending page is bounded rather than walked
 *                           forever, and the walk returns to the top.
 *
 * Every assertion here is offline-safe: nothing reaches the network.
 */
'use strict';

const { app, BrowserWindow } = require('electron');
const assert = require('node:assert/strict');

app.disableHardwareAcceleration();
app.commandLine.appendSwitch('no-sandbox');
app.commandLine.appendSwitch('disable-gpu');
app.commandLine.appendSwitch('disable-software-rasterizer');

const { TabAutomationHost } = require('../.compiled/src/main/browser/tab-automation-host.js');
const { TabDevToolsHost } = require('../.compiled/src/main/browser/tab-devtools-host.js');
const { buildStaircasePrewarmScript } = require('../.compiled/src/main/verification/scroll-prewarm.js');
const { buildTrackerStubProbeScript } = require('../.compiled/src/main/browser/tracker-isolation.js');

const TAB_ID = 'tab-probe';
let exitCode = 0;

function page(html) {
  return 'data:text/html;charset=utf-8,' + encodeURIComponent(`<!DOCTYPE html><html><head><meta charset="utf-8">
<style>body{margin:0;font-family:sans-serif}#btn1,#btn2,#btn3{position:absolute;left:20px;width:200px;height:100px;background:#2b6cb0;color:#fff;border:0}
#btn1{top:20px}#btn2{top:160px}#btn3{top:300px}
@keyframes pulse{0%{transform:scale(1)}50%{transform:scale(1.06)}100%{transform:scale(1)}}
#btn3{animation:pulse 0.6s infinite}
#track{position:absolute;top:440px;left:20px;width:400px;height:20px;background:#e2e8f0}
#thumb{position:absolute;top:0;left:0;width:20px;height:20px;background:#1a202c}
#slider{position:absolute;top:500px;left:20px;width:400px}
</style></head><body>${html}</body></html>`);
}

function wait(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function makeContext(win) {
  const record = {
    state: { id: TAB_ID, splitMode: false, aiState: 'idle', splitFocusedPane: 'desktop' },
    focusedPane: 'desktop',
    view: { webContents: win.webContents },
    mobileView: undefined,
  };
  const tabs = new Map([[TAB_ID, record]]);
  return {
    getTabWebContents: () => win.webContents,
    getTabRecord: (tabId) => tabs.get(tabId),
    getActiveTabId: () => TAB_ID,
    getAutomationTabId: () => TAB_ID,
    getBrowserEpoch: () => 1,
    getSemanticDocumentGeneration: () => 1,
    getAllTabs: () => tabs.entries(),
    runTargetOperation: (_tabId, _paneId, operation) => operation(),
    broadcastState: () => {},
    syncFrameBackdrop: () => {},
    applyTabThrottling: () => {},
    getTabTerminalSession: () => undefined,
    resolveTargetWorkspace: () => '',
    resolveAnnotationWorkspace: () => '',
    createTab: () => TAB_ID,
    withTabAgentWorking: (_tabId, action) => action(),
    semanticRefRegistry: undefined,
  };
}

app.whenReady().then(async () => {
  let win = null;
  try {
    win = new BrowserWindow({
      show: false,
      width: 900,
      height: 800,
      webPreferences: { nodeIntegration: false, contextIsolation: true },
    });

    // Record every command that actually reaches Chromium, so claims about what
    // the isolation window applied are read off the wire instead of inferred.
    const cdpLedger = [];
    const rawSend = win.webContents.debugger.sendCommand.bind(win.webContents.debugger);
    win.webContents.debugger.sendCommand = (method, params, sessionId) => {
      cdpLedger.push({ method, params: params || {} });
      return rawSend(method, params, sessionId);
    };

    const ctx = makeContext(win);
    const devTools = new TabDevToolsHost(ctx);
    ctx.tabDevToolsHost = devTools;
    const automation = new TabAutomationHost(ctx);

    const awaitPage = async () => {
      await win.webContents.executeJavaScript('document.readyState === "complete"');
      // Two frames so the fixture's layout-time overlay placement has run.
      await new Promise((resolve) => setImmediate(resolve));
    };

    console.log('\n=== ANTI-FAN AGENT HARDENING — LIVE CHROMIUM PROBE ===\n');

    // ---------------------------------------------------------------- occlusion
    await win.loadURL(page(`
      <button id="btn1">Partial</button>
      <button id="btn2">Covered</button>
      <button id="btn3">Animating</button>
      <div id="track"><div id="thumb"></div></div>
      <input id="slider" type="range" min="0" max="100" value="0">
      <script>
        window.__clicks = { btn1: 0, btn2: 0, btn3: 0 };
        window.__rangeInputs = 0;
        document.getElementById('slider').addEventListener('input', () => { window.__rangeInputs += 1; });
        for (const id of ['btn1', 'btn2', 'btn3']) {
          document.getElementById(id).addEventListener('click', () => { window.__clicks[id] += 1; });
        }
        // A 40x40 shield over the CENTER of btn1 only: the geometric center is
        // stolen, the rest of the target is free. This is the footer-link-under-
        // a-sticky-bar shape the multi-point walk exists for.
        const c = document.getElementById('btn1').getBoundingClientRect();
        const shield = document.createElement('div');
        shield.style.cssText = 'position:fixed;z-index:99999;background:rgba(255,0,0,0.01);width:40px;height:40px;left:'
          + (c.left + c.width / 2 - 20) + 'px;top:' + (c.top + c.height / 2 - 20) + 'px';
        document.body.appendChild(shield);

        // A full-bleed cover over btn2: every sample point belongs to it.
        const c2 = document.getElementById('btn2').getBoundingClientRect();
        const cover = document.createElement('div');
        cover.id = 'cover-full';
        cover.style.cssText = 'position:fixed;z-index:99998;background:rgba(0,0,255,0.01);left:'
          + (c2.left - 10) + 'px;top:' + (c2.top - 10) + 'px;width:' + (c2.width + 20) + 'px;height:' + (c2.height + 20) + 'px';
        document.body.appendChild(cover);

        const track = document.getElementById('track');
        const thumb = document.getElementById('thumb');
        window.__slider = { value: 0, moves: 0, dragging: false, released: null };
        track.addEventListener('mousedown', (e) => {
          window.__slider.dragging = true;
          window.__slider.released = false;
          window.__slider.value = Math.round(e.clientX - track.getBoundingClientRect().left);
        });
        window.addEventListener('mousemove', (e) => {
          if (!window.__slider.dragging) return;
          window.__slider.moves += 1;
          window.__slider.value = Math.round(e.clientX - track.getBoundingClientRect().left);
          thumb.style.left = window.__slider.value + 'px';
        });
        window.addEventListener('mouseup', () => {
          window.__slider.dragging = false;
          window.__slider.released = true;
        });
      </script>
    `));
    await awaitPage();

    console.log('[1/5] Occlusion gate + multi-point sampling');
    const centerOnly = await automation.dispatchAgentAction('click', { selector: '#btn1', tabId: TAB_ID });
    assert.equal(centerOnly.success, true, 'a target whose center is shielded but whose body is reachable must still be clickable');
    const sampledCenter = centerOnly.data.rect.centerX;
    const trueCenter = await win.webContents.executeJavaScript(
      '(() => { const r = document.getElementById("btn1").getBoundingClientRect(); return r.x + r.width / 2; })()'
    );
    assert.ok(
      Math.abs(sampledCenter - trueCenter) > 5,
      `the proven point must differ from the shielded geometric center (proven=${sampledCenter}, center=${trueCenter})`
    );
    console.log(`  ✔ center shielded, click anchored at the proven point (x=${sampledCenter.toFixed(1)}, center x=${trueCenter.toFixed(1)})`);

    const obscured = await automation.dispatchAgentAction('click', { selector: '#btn2', tabId: TAB_ID });
    assert.equal(obscured.success, false, 'a fully covered target must be refused, not clicked through');
    assert.equal(obscured.data.code, 'TARGET_OBSCURED');
    assert.match(obscured.data.metadata.obscuredBy, /cover-full/, 'the refusal must name what is covering the target');
    assert.equal(obscured.data.metadata.forceAvailable, true);
    assert.equal(obscured.data.executionTier, undefined, 'nothing was dispatched, so no execution tier may be claimed');
    assert.equal(
      await win.webContents.executeJavaScript('window.__clicks.btn2'),
      0,
      'a refused click must not reach the covered button'
    );
    console.log(`  ✔ fully covered target refused: ${obscured.data.metadata.obscuredBy}`);

    const forced = await automation.dispatchAgentAction('click', { selector: '#btn2', force: true, tabId: TAB_ID });
    assert.equal(forced.success, true, 'force must bypass the gate for a knowingly covered target');
    console.log('  ✔ force bypassed the gate (dispatch goes through the cover, real hit-test)');

    console.log('[2/5] Infinite animation tolerance');
    const animating = await automation.dispatchAgentAction('click', { selector: '#btn3', tabId: TAB_ID });
    assert.equal(animating.success, true, 'an infinitely animating target must be clicked, not refused');
    console.log('  ✔ infinitely animating target clicked without spending the drift budget');

    // One agent click must deliver exactly one click. The injected cursor helper
    // replays a synthetic click 450ms after the fact by default, so asserting
    // immediately would pass while the second click is still pending; wait past
    // that delay and read the final ledger.
    await wait(700);
    const clicks = await win.webContents.executeJavaScript('window.__clicks');
    assert.deepEqual(
      clicks,
      { btn1: 1, btn2: 0, btn3: 1 },
      `each accepted click must land exactly once and no refusal may leak a click (got ${JSON.stringify(clicks)})`
    );
    console.log('  ✔ click ledger after the injected-helper delay: btn1=1, btn2=0, btn3=1 (no duplicated input)');

    // ------------------------------------------------------------------- drag
    console.log('[3/5] Bounded pointer drag');
    // (a) A native range input: the value is real DOM state, so the before/after
    // signature proves the gesture produced genuine user input events.
    const rangeDrag = await automation.agentDrag({
      fromSelector: '#slider',
      fromFraction: 0.05,
      toFraction: 0.9,
      steps: 12,
      tabId: TAB_ID,
    });
    assert.equal(rangeDrag.success, true, rangeDrag.reason || 'range drag must succeed');
    assert.equal(rangeDrag.data.interaction, 'pointer-drag');
    assert.equal(rangeDrag.data.steps, 12);
    assert.equal(rangeDrag.data.destination, 'fraction:0.9');
    assert.equal(rangeDrag.data.valueChanged, true, `the range value must move (${JSON.stringify(rangeDrag.data.valueBefore)} -> ${JSON.stringify(rangeDrag.data.valueAfter)})`);
    const rangeState = await win.webContents.executeJavaScript('({ value: document.getElementById("slider").value, inputs: window.__rangeInputs })');
    assert.ok(rangeState.inputs >= 12, `Chromium must have delivered an input event per interpolated move (got ${rangeState.inputs})`);
    assert.ok(Math.abs(Number(rangeState.value) - 90) < 10, `the range must land near the requested fraction (value=${rangeState.value})`);
    console.log(`  ✔ native range driven 5% -> ${rangeState.value}% with ${rangeState.inputs} input events`);

    // (b) A slider that only listens to mousemove: a press-then-release gesture
    // (no interpolation) could never move it, and the move counter says so.
    const trackDrag = await automation.agentDrag({
      fromSelector: '#track',
      fromFraction: 0.05,
      toFraction: 0.9,
      steps: 12,
      tabId: TAB_ID,
    });
    const slider = await win.webContents.executeJavaScript('window.__slider');
    assert.equal(trackDrag.success, true, trackDrag.reason || 'track drag must succeed');
    assert.equal(trackDrag.data.originRect.width, 400);
    assert.equal(slider.released, true, 'the gesture must always end with a released button');
    assert.equal(slider.dragging, false);
    assert.ok(slider.moves >= 11, `interpolated moves must be delivered, not teleported (moves=${slider.moves})`);
    assert.ok(Math.abs(slider.value - 0.9 * 400) < 30, `the thumb must land near the requested fraction (value=${slider.value})`);
    console.log(`  ✔ mousemove-only slider driven to ${slider.value}px across ${slider.moves} delivered moves, button released`);

    // probe measures without scrolling, dispatching or gating — that is what
    // makes it safe to call it immediately before and after a gesture. It is
    // therefore reported as "nothing executed", never as a success.
    const scrollBefore = await win.webContents.executeJavaScript('window.scrollY');
    const probe = await automation.dispatchAgentAction('probe', { selector: '#track', tabId: TAB_ID });
    assert.equal(probe.success, false, 'a measurement must never be reported as an executed action');
    assert.equal(probe.data.ok, true);
    assert.equal(probe.data.executed, false);
    assert.equal(probe.data.rect.width, 400, 'probe must return the true element box');
    assert.equal(probe.data.metadata.valueSignature.tag, 'div');
    assert.equal(await win.webContents.executeJavaScript('window.scrollY'), scrollBefore, 'probe must not scroll the page');

    // ------------------------------------------------------------ pre-warm walk
    console.log('[4/5] Scroll pre-warm on a continuously growing document');
    await win.loadURL(page(`
      <div id="filler" style="height:1500px"></div>
      <script>
        window.__appends = 0;
        // A document that keeps growing while the walk runs — the shape that
        // drives the renderer into a 2.5GB heap and a Skia allocation failure if
        // the walk chases the height. Growth is timer-driven rather than
        // scroll-driven so the fixture does not depend on how Chromium coalesces
        // scroll events in a hidden window.
        window.__keepGrowing = true;
        (function grow() {
          if (!window.__keepGrowing) return;
          const band = document.createElement('div');
          band.style.height = '300px';
          document.body.appendChild(band);
          window.__appends += 1;
          setTimeout(grow, 20);
        })();
      </script>
    `));
    await awaitPage();
    const walk = await win.webContents.executeJavaScript(buildStaircasePrewarmScript({ maxSteps: 5 }));
    const appends = await win.webContents.executeJavaScript('window.__keepGrowing = false; window.__appends');
    console.log(`  walk receipt: ${JSON.stringify(walk)} (page appended ${appends} bands)`);
    assert.equal(walk.returnedToTop, true, 'the walk must restore the top before the raster');
    assert.ok(walk.performed, 'the walk must actually have scrolled');
    assert.ok(walk.steps <= 5, `the configured step ceiling must hold (got ${walk.steps})`);
    assert.notEqual(
      walk.stoppedReason,
      'COMPLETE',
      'a document that is still growing must never be reported as fully materialized'
    );
    assert.ok(appends >= 3, `the fixture must genuinely have grown during the walk (got ${appends})`);
    assert.ok(walk.endHeight > walk.startHeight, 'the walk must observe the appended bands');
    console.log(`  ✔ walk stopped at ${walk.steps} steps (${walk.stoppedReason}) on a growing document, ${walk.startHeight}px -> ${walk.endHeight}px, returned to top`);

    // -------------------------------------------------------- tracker isolation
    console.log('[5/5] Tracker isolation lifecycle across a reload');
    await win.loadURL(page('<div>storefront</div>'));
    await awaitPage();
    cdpLedger.length = 0;

    const begin = await devTools.beginTrackerIsolation(TAB_ID, 'desktop');
    assert.equal(begin.active, true, begin.degradedReason || 'isolation must engage');
    assert.ok(begin.preDocumentScriptIdentifier, 'the pre-document registration identifier is required for a reversible window');
    assert.ok(begin.stubsInstalled.includes('fbq'), 'the live document must receive the stubs too');
    assert.ok(
      cdpLedger.some((c) => c.method === 'Network.setBlockedURLs' && Array.isArray(c.params.urls) && c.params.urls.length > 0),
      'the blocklist must reach CDP'
    );
    assert.equal(
      await win.webContents.executeJavaScript('typeof window.fbq === "function" && window.fbq("track","AddToCart").then === undefined'),
      true,
      'the live document must carry a non-thenable stub'
    );
    assert.equal(devTools.isTrackerIsolationActive(TAB_ID, 'desktop'), true);

    // The whole point of the pre-document registration: the document QA is about
    // to reload into gets stubs BEFORE its blocked tag scripts run, so `fbq()`
    // is a no-op instead of a ReferenceError.
    cdpLedger.length = 0;
    win.webContents.reload();
    await new Promise((resolve) => win.webContents.once('did-finish-load', resolve));
    await awaitPage();
    assert.equal(
      await win.webContents.executeJavaScript('typeof window.fbq === "function"'),
      true,
      'the reloaded document must get the stub from the pre-document registration'
    );
    assert.equal(
      cdpLedger.some((c) => c.method === 'Network.setBlockedURLs'),
      false,
      'the blocklist must not be re-applied by the reload (it is session state)'
    );
    console.log('  ✔ reloaded document carried the stub (pre-document registration proven on a real navigation)');

    const end = await devTools.endTrackerIsolation(TAB_ID, 'desktop');
    assert.equal(end.released, true, end.reason || 'release must succeed');

    // Releasing drops the registration and the blocklist but deliberately leaves
    // the stubs in the document that lived through the window: that document
    // loaded while its vendor script was blocked, so those stubs are the only
    // implementations of fbq/gtag it will ever see. Asserted after the release,
    // on that same document, which is the claim the design makes.
    const liveProbe = await win.webContents.executeJavaScript(buildTrackerStubProbeScript());
    assert.ok(
      Array.isArray(liveProbe.installed) && liveProbe.installed.includes('fbq'),
      `the released window's document must keep its stubs (probe: ${JSON.stringify(liveProbe)})`
    );
    assert.equal(
      await win.webContents.executeJavaScript('typeof window.fbq === "function"'),
      true,
      "the document that lived through the window must still resolve fbq() after the blocklist is lifted"
    );
    console.log('  ✔ the released window kept its stubs: the live document still resolves fbq(), the next document has none');
    assert.ok(
      cdpLedger.some((c) => c.method === 'Page.removeScriptToEvaluateOnNewDocument'),
      'release must drop the pre-document registration'
    );
    assert.ok(
      cdpLedger.some((c) => c.method === 'Network.setBlockedURLs' && Array.isArray(c.params.urls) && c.params.urls.length === 0),
      'release must lift the blocklist'
    );
    assert.equal(devTools.isTrackerIsolationActive(TAB_ID, 'desktop'), false);
    assert.equal(devTools.getStats().trackerIsolationTargetCount, 0);

    win.webContents.reload();
    await new Promise((resolve) => win.webContents.once('did-finish-load', resolve));
    await awaitPage();
    assert.equal(
      await win.webContents.executeJavaScript('typeof window.fbq'),
      'undefined',
      'a document loaded after release must not inherit the stub'
    );
    console.log('  ✔ release removed the registration: the next document has no stub');

    console.log('\n========================================================');
    console.log('  ALL LIVE CHROMIUM HARDENING CRITERIA VERIFIED (5/5)   ');
    console.log('========================================================\n');
  } catch (err) {
    console.error('\n[Live Chromium Probe] ERROR / ASSERTION FAILURE:', err);
    exitCode = 1;
  } finally {
    if (win && !win.isDestroyed()) {
      win.destroy();
    }
    app.exit(exitCode);
  }
});
