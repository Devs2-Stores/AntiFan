/**
 * AntiFan Browser Desktop — Dev Watcher Pure Helpers
 * Side-effect-free file classifier, compiler log parser, and soft-reload bridge client.
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);

/**
 * Classify whether a changed file path is hot-swappable at runtime.
 * Strictly external override scripts in scripts/cdp/*.source.js (single level).
 */
export function isHotSwappable(relPath) {
  if (!relPath || typeof relPath !== 'string') return false;
  const normalized = relPath.replace(/\\/g, '/').replace(/^\/+/, '');
  // Strictly scripts/cdp/<name>.source.js, no nested subdirectories
  const match = /^scripts\/cdp\/([^/]+)\.source\.js$/i.exec(normalized);
  return Boolean(match && match[1]);
}

/**
 * Process a single line of `tsc --watch` output and transition state.
 */
export function processTscLine(line, state = { isTscCompiling: false, tscHasErrors: false }) {
  const next = { ...state, settled: false };

  if (line.includes('Starting incremental compilation') || line.includes('Starting compilation')) {
    next.isTscCompiling = true;
    next.tscHasErrors = false;
  }
  if (line.includes('error TS') || /Found [1-9]\d* error/.test(line)) {
    next.tscHasErrors = true;
  }
  if (line.includes('Watching for file changes')) {
    next.isTscCompiling = false;
    if (line.includes('Found 0 errors')) {
      next.tscHasErrors = false;
    }
    next.settled = true;
  }

  return next;
}

/**
 * Resolve local development Bridge info from config candidates.
 */
export function resolveDevBridgeInfo(customDirs = null) {
  const appData = process.env.APPDATA || (process.platform === 'win32' ? path.join(os.homedir(), 'AppData', 'Roaming') : os.homedir());
  const candidateDirs = customDirs || [
    process.env.ANTIFAN_CONFIG_DIR,
    process.env.ANTIFAN_DATA_ROOT ? path.join(process.env.ANTIFAN_DATA_ROOT, 'config') : null,
    path.join('E:', 'Work', '.antifan-data', 'config'),
    path.join('E:\\', 'Work', '.antifan-data', 'config'),
    path.join('E:', '.antifan-data', 'config'),
    path.join('D:', 'Work', '.antifan-data', 'config'),
    path.join(appData, 'AntiFan', 'data', 'config'),
    path.join(appData, 'antifan-browser-desktop', 'data', 'config'),
    path.join(os.homedir(), '.antifan'),
    path.join(os.homedir(), '.config', 'antifan'),
  ].filter(Boolean);
  for (const dir of candidateDirs) {
    const filePath = path.join(dir, 'bridge-dev.json');
    if (fs.existsSync(filePath)) {
      try {
        const raw = fs.readFileSync(filePath, 'utf8');
        const parsed = JSON.parse(raw);
        if (parsed && typeof parsed.port === 'number') {
          return parsed;
        }
      } catch {}
    }
  }
  return null;
}

/**
 * Send an administrative signal over WebSocket to BridgeServer with guarded settle.
 * @internal shared transport used by sendSoftReload / sendUiReload
 */
async function sendBridgeAdmin(method, { bridgeInfo = undefined, params = {}, wsFactory = null, timeoutMs = 2500 } = {}) {
  const info = bridgeInfo !== undefined ? bridgeInfo : resolveDevBridgeInfo();
  if (
    !info ||
    !Number.isInteger(info.port) ||
    info.port < 1 ||
    info.port > 65535 ||
    typeof info.token !== 'string' ||
    !info.token.trim()
  ) {
    return false;
  }
  const port = info.port;
  const token = info.token.trim();
  const wsUrl = `ws://127.0.0.1:${port}?token=${encodeURIComponent(token)}`;

  const WsClass = wsFactory || require('ws').WebSocket;

  return new Promise((resolve) => {
    let timer = null;
    let settled = false;
    let ws = null;

    const finish = (val) => {
      if (settled) return;
      settled = true;
      if (timer !== null) {
        clearTimeout(timer);
        timer = null;
      }
      try { ws?.close(); } catch {}
      resolve(val);
    };

    timer = setTimeout(() => {
      finish(false);
    }, timeoutMs);

    try {
      ws = new WsClass(wsUrl);
    } catch {
      finish(false);
      return;
    }

    const reqId = `${method}_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;

    ws.on('open', () => {
      try {
        ws.send(JSON.stringify({
          id: reqId,
          method,
          params,
        }));
      } catch {
        finish(false);
      }
    });

    ws.on('message', (raw) => {
      try {
        const msg = JSON.parse(raw.toString());
        if (msg && msg.id === reqId) {
          finish(Boolean(msg.success));
        }
      } catch {}
    });

    ws.on('error', () => {
      finish(false);
    });

    ws.on('close', () => {
      finish(false);
    });
  });
}

/**
 * Send administrative soft-reload signal over WebSocket to BridgeServer
 * (antifan.system.reloadScripts).
 */
export async function sendSoftReload({ bridgeInfo = undefined, scriptId = null, wsFactory = null, timeoutMs = 2500 } = {}) {
  return sendBridgeAdmin('antifan.system.reloadScripts', {
    bridgeInfo,
    wsFactory,
    timeoutMs,
    params: scriptId ? { scriptId } : {},
  });
}

/**
 * Send administrative UI-reload signal over WebSocket to BridgeServer
 * (antifan.system.reloadUi). Transport wrapper; server-side reloadWindow()
 * behavior is defined by NativeTabHost.
 */
export async function sendUiReload({ bridgeInfo = undefined, wsFactory = null, timeoutMs = 2500 } = {}) {
  return sendBridgeAdmin('antifan.system.reloadUi', {
    bridgeInfo,
    wsFactory,
    timeoutMs,
    params: {},
  });
}

/**
 * Classify whether a changed file path is a renderer static asset
 * (src/renderer/<name>.(css|html|js)) whose change can be applied by
 * copying static assets and reloading the UI surfaces only.
 *
 * Deliberately limited to CSS/HTML/JS: these are the code surfaces that
 * standalone/toolbar renderers read at load time. Other static copies made
 * by copy-static.mjs (e.g. antifan-logo.jpg) change rarely and intentionally
 * route to the cold relaunch path.
 */
export function isUiHotSwappable(relPath) {
  if (!relPath || typeof relPath !== 'string') return false;
  const normalized = relPath.replace(/\\/g, '/').replace(/^\/+/, '');
  return /^src\/renderer\/[^/]+\.(css|html|js)$/i.test(normalized);
}

/**
 * Create an injectable change dispatcher for coordinating hot and cold reload events.
 */
export function createChangeDispatcher({
  isHotSwappableFn = isHotSwappable,
  isUiHotSwappableFn = isUiHotSwappable,
  sendSoftReloadFn = sendSoftReload,
  sendUiReloadFn = () => Promise.resolve(false),
  copyStaticFn = () => {},
  relaunchElectronFn = () => Promise.resolve(),
  getTscCompiling = () => false,
  getTscErrors = () => false,
  getTscSettledPromise = () => Promise.resolve(true),
  getElectronProc = () => null,
  debounceMs = 500,
  tscTimeoutMs = 30000,
  log = () => {},
} = {}) {
  let pendingChangedFiles = new Set();
  let pendingResolvers = [];
  let relaunchTimer = null;
  let isDisposed = false;
  async function handleBatch(files) {
    if (isDisposed) {
      throw new Error('Dispatcher disposed');
    }
    const allHot = files.length > 0 && files.every(isHotSwappableFn);
    const allUiHot = files.length > 0 && files.every(isUiHotSwappableFn);
    const proc = getElectronProc();

    if (allHot && proc) {
      log(`Detected hot-swappable change in: ${files.join(', ')}`);
      log(`Sending soft-reload signal to BridgeServer (preserving tabs, sessions, PTY)...`);
      const ok = await sendSoftReloadFn();
      if (isDisposed) {
        throw new Error('Dispatcher disposed');
      }
      if (ok) {
        log(`Soft-reload successful! Injected scripts refreshed without restarting Electron (PID: ${proc.pid}).`);
        return { action: 'soft_reload', success: true };
      }
      log(`Soft-reload not acknowledged by BridgeServer. Falling back to full relaunch.`);
    }

    if (isDisposed) {
      throw new Error('Dispatcher disposed');
    }

    // Renderer static assets (src/renderer/*.css|html|js): copy to .compiled and
    // reload UI surfaces only — avoids a full Electron relaunch. Deliberately NO
    // relaunch fallback on failure.
    if (allUiHot && proc) {
      log(`Detected renderer UI change in: ${files.join(', ')}`);
      await copyStaticFn();
      if (isDisposed) {
        throw new Error('Dispatcher disposed');
      }
      log(`Static assets copied. Sending UI reload signal to BridgeServer (toolbar, sidebar, terminal windows)...`);
      const ok = await sendUiReloadFn();
      if (isDisposed) {
        throw new Error('Dispatcher disposed');
      }
      if (ok) {
        log(`UI reload successful! Renderer refreshed without restarting Electron (PID: ${proc.pid}).`);
        return { action: 'ui_reload', success: true };
      }
      log(`UI reload not acknowledged by BridgeServer. Assets are copied; reload the window (Ctrl+Alt+R) or restart the app to apply.`);
      return { action: 'ui_reload', success: false };
    }

    if (isDisposed) {
      throw new Error('Dispatcher disposed');
    }

    if (getTscCompiling()) {
      log(`Waiting for TypeScript compiler to finish emitting to .compiled...`);
      let timer = null;
      const timeoutPromise = new Promise((res) => {
        timer = setTimeout(() => res('TIMEOUT'), tscTimeoutMs);
      });
      const settledOrTimeout = await Promise.race([getTscSettledPromise(), timeoutPromise]);
      if (timer) clearTimeout(timer);
      if (isDisposed) {
        throw new Error('Dispatcher disposed');
      }
      if (settledOrTimeout === 'TIMEOUT') {
        log(`TypeScript compilation timed out after ${Math.round(tscTimeoutMs / 1000)}s. Skipping relaunch.`);
        return { action: 'skip_compiler_error', success: false };
      }
      const success = settledOrTimeout;
      if (!success || getTscErrors()) {
        log(`TypeScript compilation reported errors. Skipping relaunch until errors are fixed.`);
        return { action: 'skip_compiler_error', success: false };
      }
    } else if (getTscErrors()) {
      log(`TypeScript compiler has active errors. Skipping relaunch until errors are fixed.`);
      return { action: 'skip_compiler_error', success: false };
    }

    if (isDisposed) {
      throw new Error('Dispatcher disposed');
    }

    await copyStaticFn();
    if (isDisposed) {
      throw new Error('Dispatcher disposed');
    }
    await relaunchElectronFn();
    return { action: 'relaunch', success: true };
  }

  function scheduleRelaunch(filename) {
    if (isDisposed) {
      return Promise.reject(new Error('Dispatcher disposed'));
    }
    if (filename) pendingChangedFiles.add(filename);

    if (relaunchTimer) clearTimeout(relaunchTimer);
    return new Promise((resolve, reject) => {
      pendingResolvers.push({ resolve, reject });
      relaunchTimer = setTimeout(async () => {
        relaunchTimer = null;
        if (isDisposed) {
          const batchResolvers = pendingResolvers;
          pendingResolvers = [];
          for (const r of batchResolvers) {
            r.reject(new Error('Dispatcher disposed'));
          }
          return;
        }
        const files = Array.from(pendingChangedFiles);
        pendingChangedFiles.clear();
        const batchResolvers = pendingResolvers;
        pendingResolvers = [];

        try {
          const result = await handleBatch(files);
          for (const r of batchResolvers) {
            r.resolve(result);
          }
        } catch (err) {
          for (const r of batchResolvers) {
            r.reject(err);
          }
        }
      }, debounceMs);
    });
  }

  function cancel(reason = 'Dispatcher cancelled') {
    if (relaunchTimer) {
      clearTimeout(relaunchTimer);
      relaunchTimer = null;
    }
    pendingChangedFiles.clear();
    const batchResolvers = pendingResolvers;
    pendingResolvers = [];
    const err = new Error(reason);
    for (const r of batchResolvers) {
      r.reject(err);
    }
  }

  function dispose() {
    isDisposed = true;
    cancel('Dispatcher disposed');
  }

  return {
    scheduleRelaunch,
    handleBatch,
    cancel,
    dispose,
    isDisposed: () => isDisposed,
    getPendingFiles: () => Array.from(pendingChangedFiles),
  };
}
