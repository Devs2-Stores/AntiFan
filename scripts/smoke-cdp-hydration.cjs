/**
 * Extension-free CDP cookie hydration end-to-end smoke.
 *
 * Launches a REAL headless Chrome with --remote-debugging-port and an isolated
 * user-data-dir, drops two cookies via an actual HTTP response, then proves
 * LocalSessionVault.importFromLiveChromeCDP() pulls them into a session.
 * Zero extension, zero native messaging, zero config-dir pollution
 * (ANTIFAN_DATA_ROOT is redirected into a temp dir).
 */
'use strict';

process.env.ANTIFAN_DATA_ROOT = (() => {
  const fs = require('node:fs');
  const os = require('node:os');
  const path = require('node:path');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'af-cdp-data-'));
  return dir;
})();

const http = require('node:http');
const path = require('node:path');
const fs = require('node:fs');
const os = require('node:os');
const { spawn, spawnSync } = require('node:child_process');

const ROOT = path.resolve(__dirname, '..');
const CDP_PORT = 9333;
const APP_PORT = 18473;

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

function waitForProbe(timeoutMs) {
  const start = Date.now();
  return new Promise((resolve) => {
    const tick = () => {
      const req = http.get(`http://127.0.0.1:${CDP_PORT}/json/version`, { timeout: 800 }, (res) => {
        res.resume();
        res.on('end', () => resolve(true));
      });
      const retry = () => {
        if (Date.now() - start > timeoutMs) return resolve(false);
        setTimeout(tick, 250);
      };
      req.on('error', retry);
      req.on('timeout', () => {
        req.destroy();
        retry();
      });
    };
    tick();
  });
}

function createTarget(url) {
  return new Promise((resolve, reject) => {
    const req = http.request(
      { host: '127.0.0.1', port: CDP_PORT, path: `/json/new?${encodeURIComponent(url)}`, method: 'PUT' },
      (res) => {
        res.resume();
        res.on('end', () => resolve());
      }
    );
    req.on('error', reject);
    req.end();
  });
}

function killChrome(pid) {
  if (!pid) return;
  try {
    spawnSync('taskkill', ['/PID', String(pid), '/T', '/F'], { stdio: 'ignore' });
  } catch {}
}

(async () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'af-cdp-smoke-'));
  let chromePid = null;
  const server = http.createServer((req, res) => {
    if (req.url === '/set') {
      res.writeHead(302, {
        Location: '/',
        'Set-Cookie': ['af_smoke=value123; Path=/; SameSite=Lax', 'af_secure=sec456; Path=/; Secure; SameSite=None'],
      });
      res.end();
      return;
    }
    res.writeHead(200, { 'Content-Type': 'text/html' });
    res.end('<!doctype html><title>af smoke</title><p>ok</p>');
  });

  try {
    await new Promise((resolve, reject) => {
      server.listen(APP_PORT, '127.0.0.1', (err) => (err ? reject(err) : resolve()));
    });

    // 1. Launch REAL Chrome with remote debugging (headless, temp profile)
    const chrome = spawn(
      CHROME_EXE,
      [
        '--headless=new',
        `--remote-debugging-port=${CDP_PORT}`,
        `--user-data-dir=${path.join(tmpDir, 'profile')}`,
        '--no-first-run',
        '--no-default-browser-check',
        '--disable-gpu',
        'about:blank',
      ],
      { stdio: 'ignore' }
    );
    chromePid = chrome.pid;
    check('Chrome spawned', Boolean(chromePid), CHROME_EXE);

    const ready = await waitForProbe(15000);
    check('CDP /json/version reachable', ready, `port ${CDP_PORT}`);
    if (!ready) {
      console.log('SMOKE_CDP: FAILED');
      process.exit(1);
    }

    // 2. Load a page whose real HTTP response sets two cookies
    await createTarget(`http://127.0.0.1:${APP_PORT}/set`);
    await new Promise((resolve) => setTimeout(resolve, 1800));

    // 3. Pull cookies through the app's own CDP hydration path (no extension)
    const { LocalSessionVault } = require(path.join(ROOT, '.compiled', 'src', 'main', 'browser', 'local-session-vault.js'));
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
    const result = await LocalSessionVault.getInstance().importFromLiveChromeCDP(stubSession, CDP_PORT);
    check('CDP hydration success', result.success === true, result.message);
    check('imported >= 1 cookie', result.count >= 1, `count=${result.count}`);

    const smoke = recorded.find((c) => c.name === 'af_smoke');
    check('af_smoke cookie hydrated', Boolean(smoke && smoke.value === 'value123'), smoke ? `value=${smoke.value}` : 'missing');

    const secure = recorded.find((c) => c.name === 'af_secure');
    check('af_secure cookie hydrated', Boolean(secure && secure.value === 'sec456'), secure ? `value=${secure.value}` : 'missing');
  } catch (err) {
    console.error('FAIL: unexpected error:', err);
    failed = 1;
  } finally {
    killChrome(chromePid);
    await new Promise((resolve) => server.close(() => resolve()));
    try {
      fs.rmSync(tmpDir, { recursive: true, force: true });
      fs.rmSync(process.env.ANTIFAN_DATA_ROOT, { recursive: true, force: true });
    } catch {}
  }
  console.log(failed ? 'SMOKE_CDP: FAILED' : 'SMOKE_CDP: PASSED');
  process.exit(failed);
})().catch((err) => {
  console.error(err);
  process.exit(1);
});