/**
 * AntiFan Browser Desktop — Dev Watcher Pure Helpers
 * Side-effect-free file classifier, compiler log parser, and soft-reload bridge client.
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import * as crypto from 'node:crypto';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);

/**
 * Redact sensitive credentials (tokens, secrets, bearer authorization) from messages.
 */
export function redactCreds(val) {
  const str = typeof val === 'string' ? val : (val instanceof Error ? (val.stack || val.message) : String(val ?? ''));
  return str
    .replace(/(Bearer\s+)[A-Za-z0-9_\-.~+/=]+/gi, '$1[REDACTED]')
    .replace(/((?:token|secret|code)=)[^&\s]*/gi, '$1[REDACTED]')
    .replace(/(["']?(?:token|secret|code)["']?\s*[:=]\s*["'])[^"']+(["'])/gi, '$1[REDACTED]$2');
}

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
  const token = (
    (typeof info?.token === 'string' && info.token.trim()) ||
    (typeof process.env.ANTIFAN_BRIDGE_TOKEN === 'string' && process.env.ANTIFAN_BRIDGE_TOKEN.trim()) ||
    ''
  );
  if (
    !info ||
    !Number.isInteger(info.port) ||
    info.port < 1 ||
    info.port > 65535 ||
    !token
  ) {
    return false;
  }
  const port = info.port;
  const wsUrl = `ws://127.0.0.1:${port}`;

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
      ws = new WsClass(wsUrl, {
        headers: {
          authorization: `Bearer ${token}`,
        },
      });
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
  // Renderer sources: static css/html/js AND TypeScript (tsc-emitted to
  // .compiled/src/renderer/*.js, served via loadFile, applied by reloadUi).
  // Ambient .d.ts files emit nothing and are not UI surfaces.
  return /^src\/renderer\/[^/]+\.(css|html|js|ts)$/i.test(normalized) && !/\.d\.ts$/i.test(normalized);
}

/**
 * Distinguish actual files from directories reported by file watchers.
 * On Windows, fs.watch on a directory emits events for both the modified file
 * AND its containing folder (e.g. src/renderer/toolbar.ts AND src/renderer).
 * Unfiltered folder entries in a batch lack file extensions and cause allUiHot
 * to evaluate to false, erroneously forcing a full Electron relaunch.
 */
export function defaultIsFile(relPath) {
  if (!relPath || typeof relPath !== 'string') return false;
  const normalized = relPath.replace(/\\/g, '/');
  try {
    const stat = fs.statSync(path.resolve(process.cwd(), relPath));
    return stat.isFile();
  } catch {
    // If not statable on disk (deleted file or simulated path in tests),
    // require a non-empty extension (.ts, .js, .css, etc.).
    return path.extname(normalized).length > 0;
  }
}

/**
 * Create an injectable change dispatcher for coordinating hot and cold reload events.
 */
export function createChangeDispatcher({
  isHotSwappableFn = isHotSwappable,
  isUiHotSwappableFn = isUiHotSwappable,
  isFileFn = defaultIsFile,
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
  const fileHashCache = new Map();
  let pendingChangedFiles = new Set();
  let pendingResolvers = [];
  let relaunchTimer = null;
  let isDisposed = false;

  function getFileHash(relPath) {
    try {
      const full = path.resolve(process.cwd(), relPath);
      const stat = fs.statSync(full);
      if (!stat.isFile()) return null;
      const content = fs.readFileSync(full);
      return crypto.createHash('sha1').update(content).digest('hex');
    } catch {
      return null;
    }
  }

  async function handleBatch(rawFiles) {
    if (isDisposed) {
      throw new Error('Dispatcher disposed');
    }
    const candidates = Array.isArray(rawFiles) ? rawFiles.filter(isFileFn) : [];
    if (candidates.length === 0) {
      return { action: 'noop', success: true };
    }

    // De-duplicate against fileHashCache: ignore spurious Windows fs.watch events when file content has not changed
    const files = candidates.filter((f) => {
      const currentHash = getFileHash(f);
      if (!currentHash) return true;
      const prevHash = fileHashCache.get(f);
      if (prevHash && prevHash === currentHash) {
        return false;
      }
      fileHashCache.set(f, currentHash);
      return true;
    });

    if (files.length === 0) {
      return { action: 'noop', success: true };
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
      // Renderer TypeScript is emitted asynchronously by `tsc --watch`; copying
      // static assets before the emit completes would reload a stale
      // .compiled/*.js (the "hot UI vẫn chưa ăn" symptom). Wait for the
      // compiler to settle whenever a .ts renderer source is in the batch.
      const needsTscEmit = files.some((f) => /^src\/renderer\/[^/]+\.ts$/i.test(String(f).replace(/\\/g, '/')));
      if (needsTscEmit) {
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
          log(`TypeScript compilation timed out after ${Math.round(tscTimeoutMs / 1000)}s. Skipping UI reload.`);
          return { action: 'skip_compiler_error', success: false };
        }
        if (!settledOrTimeout || getTscErrors()) {
          log(`TypeScript compilation reported errors. Skipping UI reload until errors are fixed.`);
          return { action: 'skip_compiler_error', success: false };
        }
      }
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
    log(`Detected non-UI or main-process change in: ${files.join(', ')} — restarting Electron...`);
    await relaunchElectronFn();
    return { action: 'relaunch', success: true };
  }

  function scheduleRelaunch(filename) {
    if (isDisposed) {
      return Promise.reject(new Error('Dispatcher disposed'));
    }
    if (!filename || typeof filename !== 'string' || !filename.trim()) {
      return Promise.resolve({ action: 'noop', success: true });
    }
    pendingChangedFiles.add(filename.trim());

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

/**
 * Default liveness probe: `process.kill(pid, 0)` throws ESRCH when the pid is
 * gone; EPERM means the process exists but is owned by someone else — alive.
 */
export function defaultIsProcAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return err && err.code === 'EPERM';
  }
}

/**
 * Singleton guard for `npm run dev`: two watchers both watch src/** and each
 * independently relaunches Electron — they kill each other's app and drop
 * running Tasks. Acquire a pid lock; refuse to start when a LIVE watcher
 * already owns it. Stale locks (dead pid, corrupt JSON, missing file) are
 * taken over automatically.
 */
export function acquireDevLock({ lockPath, pid, isProcAlive = defaultIsProcAlive }) {
  try {
    const existing = JSON.parse(fs.readFileSync(lockPath, 'utf8'));
    if (existing && typeof existing.pid === 'number' && isProcAlive(existing.pid)) {
      return { ok: false, existingPid: existing.pid, existingStartedAt: existing.startedAt ?? null };
    }
  } catch {
    // ENOENT (no lock), SyntaxError (crash mid-write): take over below.
  }
  fs.mkdirSync(path.dirname(lockPath), { recursive: true });
  fs.writeFileSync(lockPath, JSON.stringify({ pid, root: process.cwd(), startedAt: Date.now() }, null, 2));
  return { ok: true };
}

/**
 * Remove the lock only when we still own it (pid matches); never delete a lock
 * that a successor may have written after a crash.
 */
export function releaseDevLock(lockPath, pid) {
  try {
    const existing = JSON.parse(fs.readFileSync(lockPath, 'utf8'));
    if (existing && existing.pid === pid) {
      fs.rmSync(lockPath, { force: true });
    }
  } catch {
    // No lock or unreadable: nothing to release.
  }
}
