/**
 * AntiFan Clone E2E CLI & Native Electron CDP Adapter
 * 
 * Drives interaction suite against live reference and clone targets using
 * isolated Electron browser instances with native CDP input (move/click/key/text/wheel).
 * 
 * Usage:
 *   node scripts/run-electron.cjs scripts/test-clone-features.cjs [options]
 *   node scripts/test-clone-features.cjs [options]
 * 
 * Options / Environment:
 *   --reference <url>  (or CLONE_E2E_REFERENCE / CLONE_E2E_REFERENCE_URL)
 *   --clone <url>      (or CLONE_E2E_CLONE / CLONE_E2E_CLONE_URL)
 *   --output <dir>     (or CLONE_E2E_OUTPUT / CLONE_E2E_OUTPUT_DIR)
 */
'use strict';

const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const crypto = require('node:crypto');
const { pathToFileURL } = require('node:url');
const { spawn } = require('node:child_process');

// Determine if we are running in an active Electron main process with app GUI capability
let electronModule = null;
try {
  electronModule = require('electron');
} catch {}

const hasElectronApp = Boolean(
  electronModule &&
  typeof electronModule === 'object' &&
  electronModule.app
);

// If invoked directly with Node, spawn via Electron binary with clean environment
if (!hasElectronApp) {
  const electronBin = typeof electronModule === 'string' ? electronModule : require('electron');
  const env = { ...process.env };
  delete env.ELECTRON_RUN_AS_NODE;

  const child = spawn(electronBin, [__filename, ...process.argv.slice(2)], {
    stdio: 'inherit',
    env,
  });

  child.on('exit', (code) => {
    process.exit(code !== null ? code : 1);
  });
  child.on('error', (err) => {
    console.error('[test-clone-features] Failed to spawn Electron child:', err);
    process.exit(1);
  });
  return;
}

const { app, BrowserWindow, session } = electronModule;

// Configure Electron command-line flags before app is ready
app.commandLine.appendSwitch('no-sandbox');
app.commandLine.appendSwitch('disable-gpu');
app.commandLine.appendSwitch('disable-background-timer-throttling');
app.commandLine.appendSwitch('disable-renderer-backgrounding');
app.commandLine.appendSwitch('disable-backgrounding-occluded-windows');

// Isolated ephemeral userData directory for this run — must fail closed if non-isolated
const tempUserData = fs.mkdtempSync(path.join(os.tmpdir(), 'antifan-clone-e2e-userdata-'));
if (!tempUserData || !fs.existsSync(tempUserData)) {
  throw new Error('Failed to create isolated temp userData directory');
}
app.setPath('userData', tempUserData);

// Parse CLI flags
function parseCliArgs(argv) {
  const options = {};
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--reference' && i + 1 < argv.length) {
      options.reference = argv[++i];
    } else if (arg.startsWith('--reference=')) {
      options.reference = arg.slice('--reference='.length);
    } else if (arg === '--clone' && i + 1 < argv.length) {
      options.clone = argv[++i];
    } else if (arg.startsWith('--clone=')) {
      options.clone = arg.slice('--clone='.length);
    } else if (arg === '--output' && i + 1 < argv.length) {
      options.output = argv[++i];
    } else if (arg.startsWith('--output=')) {
      options.output = arg.slice('--output='.length);
    }
  }
  return options;
}

const cliOptions = parseCliArgs(process.argv.slice(2));

const referenceUrl = cliOptions.reference
  || process.env.CLONE_E2E_REFERENCE
  || process.env.CLONE_E2E_REFERENCE_URL
  || 'https://hoplongtech.com/';

const cloneUrl = cliOptions.clone
  || process.env.CLONE_E2E_CLONE
  || process.env.CLONE_E2E_CLONE_URL
  || 'http://127.0.0.1:3300/';

const defaultOutputDir = path.resolve(
  __dirname,
  '../plans/reports/clone-e2e',
  new Date().toISOString().replace(/[:.]/g, '-')
);

const outputDir = path.resolve(
  cliOptions.output
  || process.env.CLONE_E2E_OUTPUT
  || process.env.CLONE_E2E_OUTPUT_DIR
  || defaultOutputDir
);

// User-agent constants aligned with Core dual-surface materializer
const DESKTOP_UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0.0.0 Safari/537.36';
const MOBILE_UA = 'Mozilla/5.0 (Linux; Android 14; Mobile; K) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0.6613.114 Mobile Safari/537.36';

// Key mappings for native CDP dispatch
const KEY_DEFINITIONS = {
  Tab: { code: 'Tab', key: 'Tab', keyCode: 9 },
  Escape: { code: 'Escape', key: 'Escape', keyCode: 27 },
  Enter: { code: 'Enter', key: 'Enter', keyCode: 13, text: '\r' },
  Space: { code: 'Space', key: ' ', keyCode: 32, text: ' ' },
  ' ': { code: 'Space', key: ' ', keyCode: 32, text: ' ' },
  ArrowDown: { code: 'ArrowDown', key: 'ArrowDown', keyCode: 40 },
  ArrowUp: { code: 'ArrowUp', key: 'ArrowUp', keyCode: 38 },
  ArrowLeft: { code: 'ArrowLeft', key: 'ArrowLeft', keyCode: 37 },
  ArrowRight: { code: 'ArrowRight', key: 'ArrowRight', keyCode: 39 },
  Backspace: { code: 'Backspace', key: 'Backspace', keyCode: 8 },
};

function getModifierMask(modifiers) {
  if (!modifiers || !Array.isArray(modifiers)) return 0;
  let mask = 0;
  for (const m of modifiers) {
    const mod = String(m).toLowerCase();
    if (mod === 'alt') mask |= 1;
    else if (mod === 'control' || mod === 'ctrl') mask |= 2;
    else if (mod === 'meta' || mod === 'command' || mod === 'cmd') mask |= 4;
    else if (mod === 'shift') mask |= 8;
  }
  return mask;
}

// Track active windows for reliable lifecycle teardown
const openWindows = new Set();

async function cleanup() {
  for (const win of openWindows) {
    try {
      if (!win.isDestroyed()) {
        try {
          if (win.webContents.debugger.isAttached()) {
            win.webContents.debugger.detach();
          }
        } catch {}
        win.destroy();
      }
    } catch {}
  }
  openWindows.clear();

  try {
    if (tempUserData && fs.existsSync(tempUserData)) {
      fs.rmSync(tempUserData, { recursive: true, force: true });
    }
  } catch {}
}

/**
 * Write artifact to outputDir with boundary protection against path traversal.
 */
async function writeArtifact(relativePath, content) {
  const targetPath = path.resolve(outputDir, relativePath);
  const rel = path.relative(outputDir, targetPath);
  if (rel.startsWith('..') || path.isAbsolute(rel)) {
    throw new Error(`writeArtifact: path traversal rejected for relativePath '${relativePath}'`);
  }
  await fs.promises.mkdir(path.dirname(targetPath), { recursive: true });
  if (Buffer.isBuffer(content)) {
    await fs.promises.writeFile(targetPath, content);
  } else {
    await fs.promises.writeFile(targetPath, String(content), 'utf8');
  }
}

/**
 * Creates an isolated browser instance wired to native CDP input controls.
 */
async function createBrowser(viewport) {
  const isMobile = Boolean(viewport && viewport.mobile);
  const width = Number(viewport && viewport.width) || (isMobile ? 390 : 1440);
  const height = Number(viewport && viewport.height) || (isMobile ? 844 : 900);
  const scaleFactor = isMobile ? 3 : 1;
  const userAgent = isMobile ? MOBILE_UA : DESKTOP_UA;
  const extraHeaders = isMobile ? 'sec-ch-ua-mobile: ?1\n' : 'sec-ch-ua-mobile: ?0\n';

  // Completely independent ephemeral in-memory partition per browser instance
  const partitionId = `temp-e2e-${crypto.randomUUID()}`;
  const ses = session.fromPartition(partitionId);

  const win = new BrowserWindow({
    width,
    height,
    show: false,
    skipTaskbar: true,
    backgroundThrottling: false,
    webPreferences: {
      session: ses,
      offscreen: true,
      contextIsolation: false,
      backgroundThrottling: false,
      sandbox: false,
    },
  });

  win.webContents.setBackgroundThrottling(false);
  win.webContents.setUserAgent(userAgent);
  if (typeof win.webContents.setZoomFactor === 'function') {
    win.webContents.setZoomFactor(1);
  }

  // Block popups and new windows from spawning visible windows
  win.webContents.setWindowOpenHandler((details) => {
    console.warn(`[test-clone-features] Blocked popup window to: ${details.url}`);
    return { action: 'deny' };
  });
  win.webContents.on('new-window', (e, url) => {
    e.preventDefault();
    console.warn(`[test-clone-features] Prevented new-window to: ${url}`);
  });

  openWindows.add(win);
  win.once('closed', () => openWindows.delete(win));

  // A crashed renderer leaves pending CDP promises unsettled, so the process drains its event
  // loop and exits 0 mid-suite: the gate then reports nothing about the controls it never ran.
  // Recording the death makes every later call fail loudly, and the suite records BLOCKED.
  let deathReason = null;
  win.webContents.on('render-process-gone', (_event, details) => {
    deathReason = details && details.reason ? details.reason : 'unknown';
    console.error(
      `[test-clone-features] renderer gone during ${viewport.name || 'surface'}: ${JSON.stringify(details)}`
    );
  });
  const guard = () => {
    if (deathReason) throw new Error(`SURFACE_DEAD: renderer ${deathReason}`);
  };
  const traceCdp = process.env.CLONE_E2E_TRACE ? (m) => console.log(`[cdp] ${m}`) : () => {};

  // Initialize renderer process with initial document before attaching CDP
  await win.loadURL('about:blank');

  if (!win.webContents.debugger.isAttached()) {
    win.webContents.debugger.attach('1.3');
  }

  // Configure device metrics and client hints via CDP
  await win.webContents.debugger.sendCommand('Emulation.setDeviceMetricsOverride', {
    width,
    height,
    deviceScaleFactor: scaleFactor,
    mobile: isMobile,
  });

  if (isMobile) {
    await win.webContents.debugger.sendCommand('Emulation.setTouchEmulationEnabled', {
      enabled: true,
      maxTouchPoints: 5,
    });
  }

  await win.webContents.debugger.sendCommand('Emulation.setUserAgentOverride', {
    userAgent,
    acceptLanguage: 'vi-VN,vi;q=0.9,en-US;q=0.8,en;q=0.7',
    platform: isMobile ? 'Linux armv8l' : 'Win32',
    userAgentMetadata: isMobile ? {
      mobile: true,
      platform: 'Android',
      platformVersion: '14',
      architecture: '',
      model: 'K',
      brands: [
        { brand: 'Chromium', version: '128' },
        { brand: 'Not;A=Brand', version: '24' },
        { brand: 'Google Chrome', version: '128' },
      ],
    } : {
      mobile: false,
      platform: 'Windows',
      platformVersion: '10.0.0',
      architecture: 'x86',
      model: '',
      brands: [
        { brand: 'Chromium', version: '128' },
        { brand: 'Not;A=Brand', version: '24' },
        { brand: 'Google Chrome', version: '128' },
      ],
    },
  });

  try {
    await win.webContents.debugger.sendCommand('Emulation.setFocusEmulationEnabled', { enabled: true });
  } catch {}

  return {
    async navigate(url) {
      guard();
      let navTimeout;
      let loadFailure = null;

      const onDidFailLoad = (event, errorCode, errorDescription, validatedURL, isMainFrame) => {
        if (isMainFrame && errorCode !== -3 /* net::ERR_ABORTED */) {
          loadFailure = new Error(`Navigation failed (${errorCode}): ${errorDescription} for ${validatedURL}`);
        }
      };

      win.webContents.on('did-fail-load', onDidFailLoad);

      try {
        const timeoutPromise = new Promise((_, reject) => {
          navTimeout = setTimeout(() => {
            try { win.webContents.stop(); } catch {}
            reject(new Error(`Navigation to ${url} timed out after 90 seconds`));
          }, 90_000);
        });

        const loadPromise = win.loadURL(url, {
          userAgent,
          extraHeaders,
        });

        await Promise.race([loadPromise, timeoutPromise]);

        if (loadFailure) {
          throw loadFailure;
        }

        if (win.webContents.isLoading()) {
          await new Promise((resolve) => {
            const onStopLoading = () => {
              win.webContents.removeListener('did-stop-loading', onStopLoading);
              resolve();
            };
            win.webContents.once('did-stop-loading', onStopLoading);
          });
        }

        if (loadFailure) {
          throw loadFailure;
        }

        // Re-assert CDP emulation settings after document load
        if (!win.webContents.debugger.isAttached()) {
          win.webContents.debugger.attach('1.3');
        }
        await win.webContents.debugger.sendCommand('Emulation.setDeviceMetricsOverride', {
          width,
          height,
          deviceScaleFactor: scaleFactor,
          mobile: isMobile,
        });
        if (isMobile) {
          await win.webContents.debugger.sendCommand('Emulation.setTouchEmulationEnabled', {
            enabled: true,
            maxTouchPoints: 5,
          });
        }
        try {
          await win.webContents.debugger.sendCommand('Emulation.setFocusEmulationEnabled', { enabled: true });
        } catch {}
      } finally {
        clearTimeout(navTimeout);
        win.webContents.removeListener('did-fail-load', onDidFailLoad);
      }
    },

    async evaluate(expression, timeoutMs = 30_000) {
      guard();
      let timer;
      try {
        const timeoutPromise = new Promise((_, reject) => {
          timer = setTimeout(() => {
            reject(new Error(`evaluate() timed out after ${timeoutMs}ms`));
          }, timeoutMs);
        });

        const script = typeof expression === 'function'
          ? `(${expression.toString()})()`
          : expression;

        // Dispatching script into a frame that is mid-navigation aborts the browser process
        // rather than rejecting, so the call waits out any load already in flight.
        if (win.webContents.isLoading()) {
          await new Promise((resolve) => {
            const done = () => {
              win.webContents.removeListener('did-stop-loading', done);
              resolve();
            };
            win.webContents.on('did-stop-loading', done);
            setTimeout(done, 5000);
          });
        }

        const evalPromise = win.webContents.executeJavaScript(script, true);
        traceCdp(`evaluate:start len=${script.length}`);
        const result = await Promise.race([evalPromise, timeoutPromise]);
        traceCdp('evaluate:done');
        return result;
      } finally {
        clearTimeout(timer);
      }
    },

    async move(x, y) {
      guard();
      traceCdp('move');
      const rx = Math.round(x);
      const ry = Math.round(y);
      await win.webContents.debugger.sendCommand('Input.dispatchMouseEvent', {
        type: 'mouseMoved',
        x: rx,
        y: ry,
      });
    },

    async click(x, y) {
      guard();
      traceCdp('click');
      const rx = Math.round(x);
      const ry = Math.round(y);

      if (isMobile) {
        // Native CDP touch tap: touchStart, dwell, touchEnd (mobile viewport emulation)
        await win.webContents.debugger.sendCommand('Input.dispatchTouchEvent', {
          type: 'touchStart',
          touchPoints: [{ x: rx, y: ry }],
        });

        await new Promise((r) => setTimeout(r, 60));

        await win.webContents.debugger.sendCommand('Input.dispatchTouchEvent', {
          type: 'touchEnd',
          touchPoints: [],
        });
      } else {
        // Desktop mouse click: move, press, dwell, release
        await win.webContents.debugger.sendCommand('Input.dispatchMouseEvent', {
          type: 'mouseMoved',
          x: rx,
          y: ry,
        });

        await win.webContents.debugger.sendCommand('Input.dispatchMouseEvent', {
          type: 'mousePressed',
          button: 'left',
          buttons: 1,
          clickCount: 1,
          x: rx,
          y: ry,
        });

        await new Promise((r) => setTimeout(r, 60));

        await win.webContents.debugger.sendCommand('Input.dispatchMouseEvent', {
          type: 'mouseReleased',
          button: 'left',
          buttons: 0,
          clickCount: 1,
          x: rx,
          y: ry,
        });
      }
    },

    async key(keyName, modifiers = []) {
      guard();
      traceCdp('key');
      const modMask = getModifierMask(modifiers);
      const def = KEY_DEFINITIONS[keyName] || {
        code: keyName,
        key: keyName,
        keyCode: 0,
        text: keyName.length === 1 ? keyName : undefined,
      };

      const downParams = {
        type: 'keyDown',
        modifiers: modMask,
        windowsVirtualKeyCode: def.keyCode,
        code: def.code,
        key: def.key,
      };
      if (def.text) {
        downParams.text = def.text;
        downParams.unmodifiedText = def.text;
      }

      await win.webContents.debugger.sendCommand('Input.dispatchKeyEvent', downParams);
      await new Promise((r) => setTimeout(r, 30));

      const upParams = {
        type: 'keyUp',
        modifiers: modMask,
        windowsVirtualKeyCode: def.keyCode,
        code: def.code,
        key: def.key,
      };
      await win.webContents.debugger.sendCommand('Input.dispatchKeyEvent', upParams);
    },

    async type(text) {
      guard();
      traceCdp('type');
      const str = String(text ?? '');
      if (!str) return;
      await win.webContents.debugger.sendCommand('Input.insertText', { text: str });
    },

    async scroll(x, y, deltaY) {
      guard();
      traceCdp('scroll');
      const rx = Math.round(x);
      const ry = Math.round(y);

      if (isMobile) {
        // Native CDP touch swipe: touchStart, interpolated touchMove steps, touchEnd
        const startY = ry;
        const endY = Math.round(ry - deltaY);
        await win.webContents.debugger.sendCommand('Input.dispatchTouchEvent', {
          type: 'touchStart',
          touchPoints: [{ x: rx, y: startY }],
        });

        const steps = 6;
        for (let i = 1; i <= steps; i++) {
          const curY = Math.round(startY + ((endY - startY) * i) / steps);
          await win.webContents.debugger.sendCommand('Input.dispatchTouchEvent', {
            type: 'touchMove',
            touchPoints: [{ x: rx, y: curY }],
          });
          await new Promise((r) => setTimeout(r, 16));
        }

        await win.webContents.debugger.sendCommand('Input.dispatchTouchEvent', {
          type: 'touchEnd',
          touchPoints: [],
        });
      } else {
        // Desktop mouse wheel scroll
        await win.webContents.debugger.sendCommand('Input.dispatchMouseEvent', {
          type: 'mouseWheel',
          x: rx,
          y: ry,
          deltaX: 0,
          deltaY: Math.round(deltaY),
        });
      }
    },

    async screenshot() {
      guard();
      traceCdp('screenshot:start');
      let timer;
      try {
        const timeoutPromise = new Promise((_, reject) => {
          timer = setTimeout(() => {
            reject(new Error('screenshot capture timed out after 30 seconds'));
          }, 30_000);
        });
        // CDP page capture runs through the renderer's own frame path. win.capturePage()
        // drives the offscreen software compositor, which aborts the browser process on
        // large pages instead of rejecting.
        const capturePromise = (async () => {
          const shot = await win.webContents.debugger.sendCommand('Page.captureScreenshot', {
            format: 'png',
            fromSurface: true,
            captureBeyondViewport: false,
          });
          const data = shot && shot.data ? shot.data : '';
          return Buffer.from(data, 'base64');
        })();
        const png = await Promise.race([capturePromise, timeoutPromise]);
        traceCdp('screenshot:done');
        return png;
      } finally {
        clearTimeout(timer);
      }
    },

    async close() {
      try {
        if (win.webContents.debugger.isAttached()) {
          win.webContents.debugger.detach();
        }
      } catch {}
      try {
        if (!win.isDestroyed()) {
          win.destroy();
        }
      } catch {}
      openWindows.delete(win);
    },
  };
}

// Process lifecycle termination signals
process.on('SIGINT', async () => {
  await cleanup();
  app.exit(130);
  process.exit(130);
});

process.on('SIGTERM', async () => {
  await cleanup();
  app.exit(143);
  process.exit(143);
});

process.on('unhandledRejection', async (reason) => {
  console.error('[test-clone-features] Unhandled rejection:', reason);
  await cleanup();
  app.exit(1);
  process.exit(1);
});

app.whenReady().then(async () => {
  // Required startup banner
  console.log('E2E runner ready');

  const suitePath = path.resolve(__dirname, '../packages/site-clone/dist/qa/interaction-suite.js');
  const suiteUrl = pathToFileURL(suitePath).href;

  try {
    let runInteractionSuite;
    try {
      const suiteModule = await import(suiteUrl);
      runInteractionSuite = suiteModule.runInteractionSuite;
    } catch (importErr) {
      console.error(`[test-clone-features] Failed to import interaction suite from ${suitePath}:`, importErr && importErr.message);
      process.exitCode = 1;
      return;
    }

    if (typeof runInteractionSuite !== 'function') {
      console.error(`[test-clone-features] runInteractionSuite is not a function in ${suitePath}`);
      process.exitCode = 1;
      return;
    }

    console.log(`[test-clone-features] Running interaction suite:`);
    console.log(`  Reference URL: ${referenceUrl}`);
    console.log(`  Clone URL:     ${cloneUrl}`);
    console.log(`  Output Dir:    ${outputDir}`);

    const result = await runInteractionSuite({
      referenceUrl,
      cloneUrl,
      outputDir,
      createBrowser,
      writeArtifact,
    });

    console.log(`[test-clone-features] Suite finished. Verdict: ${result?.verdict}`);
    console.log(`[test-clone-features] Summary:`, JSON.stringify(result?.summary, null, 2));

    if (result && result.verdict === 'VERIFIED') {
      process.exitCode = 0;
    } else {
      process.exitCode = 1;
    }
  } catch (err) {
    console.error('[test-clone-features] Fatal error running interaction suite:', err);
    process.exitCode = 1;
  } finally {
    await cleanup();
    const finalCode = process.exitCode !== undefined ? process.exitCode : 1;
    app.exit(finalCode);
    process.exit(finalCode);
  }
});
