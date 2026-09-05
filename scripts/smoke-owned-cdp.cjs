/**
 * Owned one-shot CDP hydrate end-to-end smoke (syncProfile entry point).
 *
 * Proves the NEW profile-bound flow end to end with a real Chrome:
 *   1. SEED a real source Chrome profile into an isolated user-data-dir:
 *      a real HTTP response drops two persistent cookies, then Chrome is
 *      closed gracefully (cookies flushed to disk).
 *   2. Point ChromeProfileSyncManager at that seed profile (chromeUserDataPath
 *      override; isChromeRunning stubbed false so the guard does not refuse on
 *      machines where the user's Chrome happens to be open).
 *   3. Invoke the ACTUAL sync entry point — syncProfile('Default', session).
 *      Inside: cloneMinimalProfile -> owned headless Chrome with
 *      --remote-debugging-port=0 (OS-assigned, read via DevToolsActivePort)
 *      -> importFromLiveChromeCDP -> kill -> deterministic temp removal.
 *   4. Assert cookies landed in the target session, the owned temp dir is
 *      gone, and the seed profile is untouched.
 * Zero extension, zero native messaging, zero config-dir pollution.
 */
'use strict';

const http = require('node:http');
const path = require('node:path');
const fs = require('node:fs');
const os = require('node:os');
const { spawn, spawnSync, execSync } = require('node:child_process');

const ROOT = path.resolve(__dirname, '..');
const APP_PORT = 18474;

const CHROME_CANDIDATES = [
  path.join(process.env.PROGRAMFILES || 'C:\\Program Files', 'Google', 'Chrome', 'Application', 'chrome.exe'),
  path.join(process.env['PROGRAMFILES(X86)'] || 'C:\\Program Files (x86)', 'Google', 'Chrome', 'Application', 'chrome.exe'),
  process.env.LOCALAPPDATA ? path.join(process.env.LOCALAPPDATA, 'Google', 'Chrome', 'Application', 'chrome.exe') : '',
].filter(Boolean);

const CHROME_EXE = process.env.CHROME_EXE || CHROME_CANDIDATES.find((candidate) => fs.existsSync(candidate));
if (!CHROME_EXE) {
  console.error('FAIL: Google Chrome not found.');
  process.exit(1);
}

let failed = 0;
function check(label, ok, detail) {
  console.log(`${ok ? 'PASS' : 'FAIL'}: ${label}${detail ? ` — ${detail}` : ''}`);
  if (!ok) failed = 1;
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Polls DevToolsActivePort in the owned user-data-dir (--remote-debugging-port=0). */
function waitForDevToolsPort(userDataDir, timeoutMs) {
  const devtoolsFile = path.join(userDataDir, 'DevToolsActivePort');
  const start = Date.now();
  return new Promise((resolve) => {
    const tick = () => {
      try {
        const raw = fs.readFileSync(devtoolsFile, 'utf8');
        const port = Number.parseInt((raw.split(/\r?\n/)[0] || '').trim(), 10);
        if (Number.isInteger(port) && port > 0) return resolve(port);
      } catch {}
      if (Date.now() - start > timeoutMs) return resolve(null);
      setTimeout(tick, 200);
    };
    tick();
  });
}

function killChrome(pid) {
  if (!pid) return;
  try {
    spawnSync('taskkill', ['/PID', String(pid), '/T', '/F'], { stdio: 'ignore' });
  } catch {}
}

/**
 * Graceful Chrome exit via CDP Browser.close, then awaits the child's exit.
 * This is what lets the cookie store commit to disk — hard-killing (taskkill
 * /F) discards pending cookie writes, which is exactly what the owned-clone
 * flow depends on in production (the user's Chrome has already shut down).
 */
async function closeChromeGracefully(child, userDataDir) {
  const portFile = path.join(userDataDir, 'DevToolsActivePort');
  const raw = fs.readFileSync(portFile, 'utf8');
  const port = Number.parseInt((raw.split(/\r?\n/)[0] || '').trim(), 10);
  const version = await new Promise((resolve, reject) => {
    http.get({ host: '127.0.0.1', port, path: '/json/version', timeout: 2000 }, (res) => {
      let body = '';
      res.on('data', (chunk) => (body += chunk));
      res.on('end', () => {
        try {
          resolve(JSON.parse(body));
        } catch (e) {
          reject(e);
        }
      });
    }).on('error', reject);
  });
  const wsUrl = version && version.webSocketDebuggerUrl;
  if (!wsUrl) throw new Error('no webSocketDebuggerUrl for graceful close');
  // Use the project's ws package (the same one LocalSessionVault drives CDP
  // with) — the undici global WebSocket fails Chrome's handshake.
  const WebSocketClient = require('ws');
  await new Promise((resolve, reject) => {
    const ws = new WebSocketClient(wsUrl);
    ws.on('open', () => ws.send(JSON.stringify({ id: 1, method: 'Browser.close' })));
    ws.on('close', () => resolve());
    ws.on('error', (e) => reject(new Error(`Browser.close ws error: ${e.message}`)));
    setTimeout(() => resolve(), 4000);
  });
  await Promise.race([
    new Promise((resolve) => child.once('exit', resolve)),
    new Promise((_, reject) => setTimeout(() => reject(new Error('Chrome did not exit after Browser.close')), 10000)),
  ]);
}

function createTarget(cdpPort, url) {
  return new Promise((resolve, reject) => {
    const req = http.request(
      { host: '127.0.0.1', port: cdpPort, path: `/json/new?${encodeURIComponent(url)}`, method: 'PUT' },
      (res) => {
        res.resume();
        res.on('end', () => resolve());
      }
    );
    req.on('error', reject);
    req.end();
  });
}

async function ownedChromeLaunch(userDataDir, extraArgs) {
  return spawn(CHROME_EXE, ['--headless=new', `--user-data-dir=${userDataDir}`, '--no-first-run', '--no-default-browser-check', '--disable-gpu', ...extraArgs], {
    stdio: 'ignore',
    windowsHide: true,
  });
}

(async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'af-owned-smoke-'));
  const seedUserData = path.join(root, 'seed-profile');
  const seedProfileDir = path.join(seedUserData, 'Default');
  const server = http.createServer((req, res) => {
    if (req.url === '/set') {
      res.writeHead(302, {
        Location: '/',
        'Set-Cookie': [
          'af_owned_smoke=value123; Max-Age=3600; Path=/; SameSite=Lax',
          'af_owned_secure=sec456; Max-Age=3600; Path=/; Secure; SameSite=None',
        ],
      });
      res.end();
      return;
    }
    res.writeHead(200, { 'Content-Type': 'text/html' });
    res.end('<!doctype html><title>owned smoke</title><p>ok</p>');
  });
  let seedChrome = null;

  // Snapshot owned temp dirs BEFORE sync so we can prove the one-shot dir is removed.
  const ownedDirsBefore = () => new Set(fs.readdirSync(os.tmpdir()).filter((n) => n.startsWith('antifan-cdp-')));
  let beforeDirs = new Set();

  try {
    await new Promise((resolve, reject) => {
      server.listen(APP_PORT, '127.0.0.1', (err) => (err ? reject(err) : resolve()));
    });

    // ---- SEED: real Chrome writes persistent cookies into seedProfileDir ----
    seedChrome = await ownedChromeLaunch(seedUserData, ['--remote-debugging-port=0', 'about:blank']);
    check('seed Chrome spawned', Boolean(seedChrome && seedChrome.pid), CHROME_EXE);
    const seedPort = await waitForDevToolsPort(seedUserData, 15000);
    check('seed Chrome CDP port assigned from DevToolsActivePort', Number.isInteger(seedPort) && seedPort > 0, `port=${seedPort}`);
    await createTarget(seedPort, `http://127.0.0.1:${APP_PORT}/set`);
    await sleep(1800);
    // Graceful close so the cookie store flushes to disk: CDP Browser.close,
    // then await the process exit. A hard kill (taskkill /F) drops pending
    // cookie-store writes — the DB would stay empty and the clone would see 0.
    await closeChromeGracefully(seedChrome, seedUserData);
    seedChrome = null;
    await sleep(800);
    const cookieDb = path.join(seedProfileDir, 'Network', 'Cookies');
    if (!(fs.existsSync(cookieDb) && fs.statSync(cookieDb).size > 0)) {
      check('seed profile cookie store persisted to disk', false, cookieDb);
    } else {
      // Prove persistence at the DB level: rows must actually be written
      // (file-exists alone proved nothing — Chrome writes the file eagerly).
      const { DatabaseSync } = require('node:sqlite');
      let rows = -1;
      const rowsDeadline = Date.now() + 15000;
      while (Date.now() < rowsDeadline) {
        try {
          const dbx = new DatabaseSync(cookieDb, { readOnly: true });
          rows = dbx.prepare('SELECT COUNT(*) AS n FROM cookies').get().n;
          dbx.close();
        } catch {
          rows = -1; // lock/WAL during checkpoint — retry
        }
        if (rows >= 2) break;
        await sleep(500);
      }
      check('seed cookie rows persisted to DB', rows >= 2, `rows=${rows}`);
    }

    // ---- TARGET: syncProfile entry point with a recording session ----
    beforeDirs = ownedDirsBefore();
    const { ChromeProfileSyncManager } = require(path.join(ROOT, '.compiled', 'src', 'main', 'browser', 'chrome-profile-sync.js'));
    const manager = ChromeProfileSyncManager.getInstance();
    // Test seam only: point the manager at the SEED profile and stub the
    // "is Chrome running" guard so the smoke never depends on the user's
    // Chrome state. The guard itself stays active in production.
    manager.chromeUserDataPath = seedUserData;
    manager.isChromeRunning = () => false;

    const recorded = [];
    const stubSession = {
      cookies: {
        async set(details) {
          recorded.push({ ...details });
          return {};
        },
        async get() {
          return recorded.filter((c) => c && c.name && c.value).map((c) => ({ ...c }));
        },
        async flushStore() {},
        async remove() {},
      },
    };

    const res = await manager.syncProfile('Default', stubSession);
    check('syncProfile success', res.success === true, res.message);
    check('syncProfile hasLiveCookies', res.hasLiveCookies === true, `cookiesCount=${res.cookiesCount}`);
    check('cookies landed in target session', recorded.filter((c) => c.name === 'af_owned_smoke' || c.name === 'af_owned_secure').length === 2, `recorded=${recorded.map((c) => c.name).join(',')}`);

    const smoke = recorded.find((c) => c.name === 'af_owned_smoke');
    check('af_owned_smoke value intact', Boolean(smoke && smoke.value === 'value123'), smoke ? `value=${smoke.value}` : 'missing');
    const secure = recorded.find((c) => c.name === 'af_owned_secure');
    check('af_owned_secure value intact', Boolean(secure && secure.value === 'sec456'), secure ? `value=${secure.value}` : 'missing');

    // ---- CLEANUP PROOF: owned temp dir removed, seed profile untouched ----
    const deadline = Date.now() + 10000;
    let ownDirsLeft = null;
    while (Date.now() < deadline) {
      const nowDirs = new Set(fs.readdirSync(os.tmpdir()).filter((n) => n.startsWith('antifan-cdp-')));
      ownDirsLeft = [...nowDirs].filter((n) => !beforeDirs.has(n));
      if (ownDirsLeft.length === 0) break;
      await sleep(300);
    }
    check('owned Chrome temp dir removed after sync', ownDirsLeft && ownDirsLeft.length === 0, ownDirsLeft ? `left=${ownDirsLeft.join(',')}` : 'all removed');

    // The owned clone is a COPY inside the temp dir — the seed source must remain.
    check('seed profile untouched', fs.existsSync(seedProfileDir) && fs.existsSync(cookieDb), seedProfileDir);
  } catch (err) {
    console.error('FAIL: unexpected error:', err);
    failed = 1;
  } finally {
    if (seedChrome) killChrome(seedChrome.pid);
    try {
      server.close();
    } catch {}
    try {
      fs.rmSync(root, { recursive: true, force: true });
    } catch {}
  }

  console.log(failed ? 'SMOKE_OWNED_CDP: FAILED' : 'SMOKE_OWNED_CDP: PASSED');
  process.exit(failed);
})().catch((err) => {
  console.error('FATAL:', err);
  process.exit(1);
});