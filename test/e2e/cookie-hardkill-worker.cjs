/**
 * Cookie hard-kill durability worker (real Electron runtime).
 *
 * Invoked twice by `scripts/smoke-cookie-hardkill-durability.cjs`:
 *
 *   --phase=set     sets a real cookie from a real HTTP response in TWO durable
 *                   partitions, then waits to be killed from outside:
 *                     `persist:profile-afsmoke`   — configured through the app's
 *                                                   own partition setup, so the
 *                                                   debounced durability commit is
 *                                                   armed.
 *                     `persist:profile-afcontrol` — opened directly with
 *                                                   `session.fromPartition`, i.e.
 *                                                   exactly the pre-fix runtime:
 *                                                   durable partition, no debounce.
 *                   The worker NEVER quits gracefully, so anything on disk was
 *                   committed by the durability policy and not by shutdown.
 *   --phase=verify  reads both jars back and prints one JSON line.
 *
 * Only the durability policy differs between the two jars, so the pair isolates
 * the debounce from Chromium's own batching timer.
 */
const path = require('node:path');
const fs = require('node:fs');
const http = require('node:http');
const { app, BrowserWindow, session } = require('electron');

const ROOT = path.resolve(__dirname, '..', '..');
const DATA_ROOT = process.env.ANTIFAN_SMOKE_ROOT;
const PHASE = (process.argv.find((a) => a.startsWith('--phase=')) || '--phase=set').slice('--phase='.length);
const COOKIE_PORT = Number(process.env.ANTIFAN_SMOKE_COOKIE_PORT || 19311);

const ARMED_PARTITION = 'persist:profile-afsmoke';
const CONTROL_PARTITION = 'persist:profile-afcontrol';

if (!DATA_ROOT) {
  console.error('FAIL: ANTIFAN_SMOKE_ROOT is required');
  process.exit(2);
}

const profilePath = path.join(DATA_ROOT, 'Profile');
fs.mkdirSync(profilePath, { recursive: true });
app.setPath('userData', profilePath);
app.setPath('sessionData', profilePath);

/** Reads one cookie by name from a session, or null when it is not on disk. */
async function readCookie(sess, name) {
  const cookies = await sess.cookies.get({});
  return cookies.find((c) => c.name === name) ?? null;
}

async function phaseVerify() {
  const armed = await readCookie(session.fromPartition(ARMED_PARTITION), 'af_armed');
  const control = await readCookie(session.fromPartition(CONTROL_PARTITION), 'af_control');
  console.log(
    `VERIFY_JSON:${JSON.stringify({
      armed: armed ? { value: armed.value, expirationDate: armed.expirationDate ?? null } : null,
      control: control ? { value: control.value, expirationDate: control.expirationDate ?? null } : null,
    })}`,
  );
  // Deliberately no graceful cleanup: the verdict is asserted by the parent from
  // the printed line, and this process must not touch either store.
  app.exit(0);
}

async function phaseSet() {
  const server = http.createServer((req, res) => {
    if (req.url === '/') {
      const oneHour = 3600;
      res.writeHead(200, {
        'Content-Type': 'text/html',
        'Set-Cookie': [
          `af_armed=armed_value; Path=/; Max-Age=${oneHour}`,
          `af_control=control_value; Path=/; Max-Age=${oneHour}`,
        ],
      });
      res.end('<!doctype html><title>cookie durability smoke</title><p>ok</p>');
      return;
    }
    res.writeHead(404);
    res.end();
  });
  await new Promise((resolve) => server.listen(COOKIE_PORT, '127.0.0.1', resolve));

  // The armed jar goes through the app's own configuration, which is the only
  // difference between the two targets.
  const { configureBrowserSessionPartition } = require(path.join(ROOT, '.compiled', 'src', 'main', 'browser', 'browser-session-partition.js'));
  configureBrowserSessionPartition(ARMED_PARTITION, 'clean');

  // Report the durability commit itself, so the parent can kill at a point that
  // is determined by the mechanism instead of by a guessed delay. This wraps the
  // session's own store method; the app behaviour is unchanged.
  const armedSession = session.fromPartition(ARMED_PARTITION);
  const originalFlushStore = armedSession.cookies.flushStore.bind(armedSession.cookies);
  armedSession.cookies.flushStore = async (...args) => {
    console.log('FLUSH_OBSERVED');
    return originalFlushStore(...args);
  };

  const controlSession = session.fromPartition(CONTROL_PARTITION);

  const url = `http://127.0.0.1:${COOKIE_PORT}/`;
  const windows = [
    new BrowserWindow({ show: false, webPreferences: { session: session.fromPartition(ARMED_PARTITION) } }),
    new BrowserWindow({ show: false, webPreferences: { session: controlSession } }),
  ];
  await Promise.all(windows.map((w) => w.loadURL(url)));

  // Both jars must actually hold the cookie before the kill: otherwise the
  // experiment would "prove" durability for a cookie that was never set.
  const armedBefore = await readCookie(session.fromPartition(ARMED_PARTITION), 'af_armed').catch(() => null);
  const controlBefore = await readCookie(controlSession, 'af_control').catch(() => null);
  // Observe the wiring, not only the behaviour: asking to arm a jar that the
  // production configure path already armed returns false. If that path ever
  // stops arming, this flips to true and the parent smoke says so instead of
  // leaving the loss to be discovered after a hard kill.
  const { armCookieDurability } = require(path.join(ROOT, '.compiled', 'src', 'main', 'browser', 'cookie-durability.js'));
  const armedReArm = armCookieDurability(session.fromPartition(ARMED_PARTITION));
  console.log(
    `SET_JSON:${JSON.stringify({
      armedBefore: armedBefore?.value ?? null,
      controlBefore: controlBefore?.value ?? null,
      armedReArm,
    })}`,
  );

  console.log('PHASE_SET_READY');
  // Idle: the parent kills this process here. No flushStore, no quit path.
  setInterval(() => {}, 1000);
}

app.whenReady().then(() =>
  (PHASE === 'verify' ? phaseVerify() : phaseSet()).catch((err) => {
    console.error('FAIL:', err && err.stack ? err.stack : String(err));
    process.exit(1);
  })
);
