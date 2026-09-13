#!/usr/bin/env node
/**
 * AntiFan — Phase 0 hardware spike: Real iPhone automation path.
 *
 * WHAT THIS PROVES (and nothing else):
 *   Windows USB presence -> host usbmux service -> WDA HTTP transport -> Safari session -> navigate
 *   -> screenshot -> cleanup
 *
 * WHAT THIS DOES NOT PROVE (Phase 3, requires Web Inspector + Remote Automation):
 *   DOM, CSS, JS, console, network, URL readback.
 *
 * Zero runtime dependencies. Node >= 20 (global fetch + AbortSignal.timeout).
 * WDA REST semantics were read from WebDriverAgent source, not assumed:
 *   - POST /session          requires {"capabilities": {"alwaysMatch": {...}}} (W3C); keys are
 *                            stripped of the "appium:" prefix; bundleId + initialUrl are WDA caps.
 *                            initialUrl (Safari at launch) only works on iOS >= 16.4.
 *   - POST /session/:id/url  is XCUIDevice fb_openUrl: a deep-link open with NO page-load wait.
 *   - GET  /session/:id/screenshot  returns {"value": "<base64 PNG>"}; in-process, no Web Inspector.
 *   - GET  /status           is session-less and standalone.
 *   - There is NO GET /url route: URL readback does not exist on the no-Appium path.
 *
 * Usage:
 *   node scripts/probe-iphone-hardware.mjs                       # auto transport sweep + full gate
 *   node scripts/probe-iphone-hardware.mjs --url http://127.0.0.1:8100
 *   node scripts/probe-iphone-hardware.mjs --candidates http://127.0.0.1:8100,http://192.168.1.24:8100
 *   node scripts/probe-iphone-hardware.mjs --test-url https://my-preview.myharavan.com/?preview_theme_id=1
 *   node scripts/probe-iphone-hardware.mjs --touch --json
 *   node scripts/probe-iphone-hardware.mjs --help
 *
 * Environment equivalents:
 *   ANTIFAN_WDA_URL, ANTIFAN_WDA_CANDIDATES, ANTIFAN_TEST_URL, ANTIFAN_SPIKE_OUT
 */

import fs from 'node:fs';
import net from 'node:net';
import path from 'node:path';
import process from 'node:process';
import { execFile } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SAFARI_BUNDLE_ID = 'com.apple.mobilesafari';

const PASS = 'pass';
const FAIL = 'fail';
const UNKNOWN = 'unknown';

const HELP = `
AntiFan Phase 0 — Real iPhone hardware spike

  node scripts/probe-iphone-hardware.mjs [options]

Options
  --url <base>            Single WDA base URL (skips the candidate sweep)
  --candidates <list>     Comma-separated WDA base URLs tried in order
                          default: http://127.0.0.1:8100
  --test-url <url>        Page opened in Safari. default: https://example.com
                          Prefer a real staging/preview URL: iPhone Safari cannot reach
                          the Windows loopback. Use an HTTPS preview URL, a LAN IP
                          (http://192.168.x.x:port), or a tunnel URL.
  --out <dir>             Evidence directory. default: scratch/spike-out
  --timeout <ms>          Per-request timeout. default: 15000
  --probe-timeout <ms>    Per-candidate transport probe timeout. default: 4000
  --touch                 Extra layer: W3C /actions tap + screenshot delta (not part of the MVP gate)
  --skip-cleanup          Keep the WDA session open after the run
  --json                  Emit the machine-readable report on stdout
  --help                  This text

Transports that expose WDA to a Windows host (pick one; the spike itself needs no Appium server)
  npm i -g go-ios                 then:  ios forward 8100 8100
                                  iOS 17+: run "ios tunnel start" first and place wintun.dll in C:\\Windows\\system32
  pip install pymobiledevice3     then:  pymobiledevice3 usbmux forward 8100 8100
  libimobiledevice build          then:  iproxy 8100 8100       (NOT the npm "iproxy" package - that is an image proxy)
  same Wi-Fi, no forwarder        then:  --candidates http://<iphone-wifi-ip>:8100

Host layers, in the order the spike reports them
  usb_presence    Windows sees an Apple USB device (VID_05AC): cable, port and "Trust This Computer"
  host_service    usbmuxd is reachable (named pipe, or tcp 127.0.0.1:27015)
  transport       a WDA base URL answers
A phone that is visible over USB while usbmuxd is missing means the cable and pairing are fine and
only Apple Mobile Device Support is absent - a different fix from "nothing on the USB bus at all".

Exit codes
  0 GO            every required layer passed
  1 NO_GO         a required layer failed; the failing layer and its code are printed
  2 INCONCLUSIVE  host prerequisites missing (no device/transport reachable) - not proof of "hardware unusable"
`;

function parseArgs(argv) {
  const opts = {
    candidates: [],
    testUrl: process.env.ANTIFAN_TEST_URL || 'https://example.com',
    outDir: process.env.ANTIFAN_SPIKE_OUT || path.join(HERE, '..', 'scratch', 'spike-out'),
    timeoutMs: 15000,
    probeTimeoutMs: 4000,
    settleAttempts: 10,
    settleIntervalMs: 1000,
    touch: false,
    skipCleanup: false,
    json: false,
    help: false,
  };
  const envCandidates = (process.env.ANTIFAN_WDA_CANDIDATES || '').split(',');
  const envUrl = process.env.ANTIFAN_WDA_URL;

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    const next = () => {
      const value = argv[i + 1];
      if (value === undefined) throw new Error(`missing value for ${arg}`);
      i += 1;
      return value;
    };
    switch (arg) {
      case '--url': opts.candidates = [next()]; break;
      case '--candidates': opts.candidates = next().split(',').map((s) => s.trim()).filter(Boolean); break;
      case '--test-url': opts.testUrl = next(); break;
      case '--out': opts.outDir = next(); break;
      case '--timeout': opts.timeoutMs = Number(next()); break;
      case '--probe-timeout': opts.probeTimeoutMs = Number(next()); break;
      case '--touch': opts.touch = true; break;
      case '--skip-cleanup': opts.skipCleanup = true; break;
      case '--json': opts.json = true; break;
      case '--help': case '-h': opts.help = true; break;
      default: throw new Error(`unknown option: ${arg}`);
    }
  }

  if (!opts.candidates.length) {
    opts.candidates = envUrl ? [envUrl] : envCandidates.filter(Boolean);
  }
  if (!opts.candidates.length) opts.candidates = ['http://127.0.0.1:8100'];
  opts.candidates = opts.candidates.map((c) => c.replace(/\/+$/, ''));
  return opts;
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function gate(id, status, code, detail, action, evidence) {
  return { id, status, code: code ?? null, detail, action: action ?? null, evidence: evidence ?? null };
}

function describeNetError(err) {
  const code = err?.cause?.code || err?.code;
  if (err?.name === 'TimeoutError' || code === 'UND_ERR_CONNECT_TIMEOUT') return 'TIMEOUT';
  if (code) return String(code);
  return err?.message ? String(err.message) : 'UNKNOWN_ERROR';
}

async function wda(base, method, route, body, timeoutMs) {
  const startedAt = Date.now();
  try {
    const res = await fetch(`${base}${route}`, {
      method,
      headers: body === undefined ? undefined : { 'content-type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: AbortSignal.timeout(timeoutMs),
    });
    const text = await res.text();
    let json = null;
    try { json = text ? JSON.parse(text) : null; } catch { json = null; }
    return {
      ok: res.ok,
      httpStatus: res.status,
      json,
      text: text.slice(0, 4000),
      ms: Date.now() - startedAt,
    };
  } catch (err) {
    return { ok: false, error: describeNetError(err), ms: Date.now() - startedAt };
  }
}

/** WDA failures return {"value":{"error":...,"message":...}} with HTTP 500. */
function wdaError(result) {
  const message = result?.json?.value?.message;
  if (message) return String(message).split('\n')[0].slice(0, 300);
  if (result?.error) return result.error;
  return `HTTP ${result?.httpStatus ?? '???'}`;
}

function compareVersions(a, b) {
  const pa = String(a).split('.').map((n) => Number.parseInt(n, 10) || 0);
  const pb = String(b).split('.').map((n) => Number.parseInt(n, 10) || 0);
  for (let i = 0; i < Math.max(pa.length, pb.length); i += 1) {
    const d = (pa[i] ?? 0) - (pb[i] ?? 0);
    if (d !== 0) return d > 0 ? 1 : -1;
  }
  return 0;
}

function pngInfo(buffer) {
  const signature = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
  if (buffer.length < 24) return null;
  for (let i = 0; i < signature.length; i += 1) {
    if (buffer[i] !== signature[i]) return null;
  }
  return { width: buffer.readUInt32BE(16), height: buffer.readUInt32BE(20) };
}

function probeTcp(port, host, timeoutMs) {
  return new Promise((resolve) => {
    const socket = net.connect({ port, host });
    let settled = false;
    const finish = (result) => {
      if (settled) return;
      settled = true;
      socket.destroy();
      resolve(result);
    };
    socket.setTimeout(timeoutMs);
    socket.once('connect', () => finish({ ok: true, detail: `tcp ${host}:${port} accepting` }));
    socket.once('error', (err) => finish({ ok: false, detail: `tcp ${host}:${port} ${err.code || err.message}` }));
    socket.once('timeout', () => finish({ ok: false, detail: `tcp ${host}:${port} TIMEOUT` }));
  });
}

function probeNamedPipe(pipePath, timeoutMs) {
  return new Promise((resolve) => {
    const socket = net.connect({ path: pipePath });
    let settled = false;
    const finish = (result) => {
      if (settled) return;
      settled = true;
      socket.destroy();
      resolve(result);
    };
    socket.setTimeout(timeoutMs);
    socket.once('connect', () => finish({ ok: true, detail: `${pipePath} accepting` }));
    socket.once('error', (err) => finish({ ok: false, detail: `${pipePath} ${err.code || err.message}` }));
    socket.once('timeout', () => finish({ ok: false, detail: `${pipePath} TIMEOUT` }));
  });
}

const FORWARDER_BINARIES = ['iproxy.exe', 'iproxy', 'ios.exe', 'ios', 'pymobiledevice3.exe', 'pymobiledevice3', 'tidevice.exe', 'tidevice'];

function detectForwarders() {
  const pathEntries = (process.env.PATH || '').split(path.delimiter).filter(Boolean);
  const found = new Set();
  for (const entry of pathEntries) {
    for (const binary of FORWARDER_BINARIES) {
      try {
        if (fs.existsSync(path.join(entry, binary))) found.add(binary.replace(/\.exe$/, ''));
      } catch { /* unreadable PATH entry */ }
    }
  }
  return [...found];
}

// ---------------------------------------------------------------- layers

const APPLE_USB_VENDOR = 'VID_05AC';

/**
 * Does Windows itself see an Apple USB device? A lone usbmuxd check conflates three very different
 * states: nothing on the bus (cable/port/pairing), the phone enumerated but without Apple Mobile
 * Device Support, and usbmuxd up. Non-Windows hosts report unknown - this layer is diagnostic only.
 */
function probeAppleUsbPresence(timeoutMs) {
  if (process.platform !== 'win32') {
    return Promise.resolve({ state: UNKNOWN, detail: 'Apple USB presence check is Windows-only', devices: [], serial: null });
  }
  const { promise, resolve } = Promise.withResolvers();
  const script = "$ErrorActionPreference='SilentlyContinue'; "
    + `Get-PnpDevice -PresentOnly | Where-Object { $_.InstanceId -like '*${APPLE_USB_VENDOR}*' } | `
    + 'Select-Object Status,Class,FriendlyName,InstanceId | ConvertTo-Json -Compress';
  execFile('powershell', ['-NoProfile', '-NonInteractive', '-Command', script], { timeout: timeoutMs }, (error, stdout) => {
    if (error) {
      resolve({ state: UNKNOWN, detail: `could not read the Windows device tree (${error.message})`, devices: [], serial: null });
      return;
    }
    const text = String(stdout || '').trim();
    if (!text) {
      resolve({ state: FAIL, code: 'USB_DEVICE_ABSENT', detail: `Windows sees no Apple USB device (${APPLE_USB_VENDOR})`, devices: [], serial: null });
      return;
    }
    let parsed;
    try {
      parsed = JSON.parse(text);
    } catch (err) {
      resolve({ state: UNKNOWN, detail: `unparsable Windows device data (${err.message})`, devices: [], serial: null });
      return;
    }
    const devices = (Array.isArray(parsed) ? parsed : [parsed]).map((entry) => ({
      status: entry.Status,
      className: entry.Class,
      name: entry.FriendlyName,
      instanceId: entry.InstanceId,
    }));
    const serial = devices.map((device) => /VID_05AC[^\\]*\\([0-9A-Za-z-]{8,})/.exec(device.instanceId || '')).find(Boolean)?.[1] ?? null;
    const names = [...new Set(devices.map((device) => device.name).filter(Boolean))].join(', ');
    resolve({
      state: PASS,
      detail: `Windows sees ${devices.length} Apple USB device(s)${serial ? ` (serial ${serial})` : ''}: ${names}`,
      devices,
      serial,
    });
  });
  return promise;
}

async function layerUsbPresence(opts) {
  const evidence = await probeAppleUsbPresence(Math.max(opts.probeTimeoutMs, 20000));
  if (evidence.state === PASS) return gate('usb_presence', PASS, null, evidence.detail, null, evidence);
  if (evidence.state === FAIL) {
    return gate('usb_presence', FAIL, evidence.code, evidence.detail,
      'Reconnect the iPhone with a data-capable cable, unlock it, accept "Trust This Computer", then rerun.',
      evidence);
  }
  return gate('usb_presence', UNKNOWN, null, evidence.detail, null, evidence);
}

async function layerHostService(opts, presence) {
  const evidence = { forwarders: detectForwarders(), usbmuxd: null };
  const probes = [];

  if (process.platform === 'win32') {
    probes.push(probeNamedPipe('\\\\.\\pipe\\usbmuxd', opts.probeTimeoutMs));
    probes.push(probeTcp(27015, '127.0.0.1', opts.probeTimeoutMs));
  } else {
    probes.push(probeTcp(27015, '127.0.0.1', opts.probeTimeoutMs));
    probes.push(probeNamedPipe('/var/run/usbmuxd', opts.probeTimeoutMs));
  }
  const results = await Promise.all(probes);
  evidence.usbmuxd = results;
  const reachable = results.some((r) => r.ok);

  if (reachable) {
    return gate('host_service', PASS, null,
      `usbmuxd reachable (${results.find((r) => r.ok).detail}); forwarders on PATH: ${evidence.forwarders.join(', ') || 'none'}`,
      evidence.forwarders.length ? null : 'No forwarder binary on PATH. A direct Wi-Fi candidate (http://<iphone-ip>:8100) still works without one.',
      evidence);
  }
  const action = presence?.state === PASS
    ? `Windows already enumerates the iPhone over USB${presence.serial ? ` (serial ${presence.serial})` : ''}, so the cable, port and pairing are fine: only Apple Mobile Device Support (the usbmuxd host service) is missing. Install the standalone (non-Microsoft-Store) iTunes for Windows, or the Apple Devices app.`
    : presence?.state === FAIL
      ? 'Windows sees no Apple USB device at all - fix the cable, port and "Trust This Computer" prompt before installing anything.'
      : 'Install Apple Mobile Device Support (standalone iTunes for Windows, non-Microsoft-Store installer) and connect the iPhone by USB. If the phone is NOT connected yet, this is expected - rerun after connecting.';
  return gate('host_service', FAIL, 'HOST_SERVICE_MISSING',
    `usbmuxd not reachable (${results.map((r) => r.detail).join(' | ')}); forwarders on PATH: ${evidence.forwarders.join(', ') || 'none'}${presence?.serial ? `; Windows USB serial ${presence.serial}` : ''}`,
    action,
    evidence);
}

async function layerTransport(opts) {
  const attempts = [];
  for (const base of opts.candidates) {
    const result = await wda(base, 'GET', '/status', undefined, opts.probeTimeoutMs);
    const body = result.json;
    const isWda = Boolean(body && (body.value?.ready !== undefined || body.value?.message !== undefined || body.value?.state !== undefined));
    attempts.push({
      base,
      ok: result.ok,
      httpStatus: result.httpStatus ?? null,
      error: result.error ?? null,
      wdaShaped: isWda,
      connectionLevel: Boolean(result.error),
      ms: result.ms,
    });
    if (result.ok && isWda) {
      return {
        transport: gate('transport', PASS, null,
          `${base} answered /status as WebDriverAgent in ${result.ms} ms`,
          null, { attempts }),
        base,
        status: body,
      };
    }
  }

  const detail = attempts
    .map((a) => `${a.base} -> ${a.error ? a.error : `HTTP ${a.httpStatus}${a.wdaShaped ? '' : ' (not WDA-shaped body)'}`}`)
    .join(' | ');
  return {
    transport: gate('transport', FAIL, 'TRANSPORT_UNREACHABLE', detail,
      'Nothing is exposing WDA to this host yet. Check, in order: (1) WDA runner is actually running on the iPhone; '
      + '(2) a forwarder maps it to a candidate URL (go-ios "ios forward 8100 8100", or pymobiledevice3 "usbmux forward 8100 8100"); '
      + '(3) on iOS 17+ launch the runner through a tunnel (go-ios "ios tunnel start", needs wintun.dll) - tapping the app icon on the device is not enough on Windows. '
      + 'For a same-Wi-Fi setup pass --candidates http://<iphone-wifi-ip>:8100.',
      {
        attempts,
        mismatch: attempts.some((a) => a.httpStatus !== null && !a.wdaShaped),
        reachedNothing: attempts.every((a) => a.connectionLevel),
      }),
    base: null,
    status: null,
  };
}

function layerWdaStatus(status) {
  if (!status) return gate('wda_status', UNKNOWN, 'WDA_NOT_REACHED', 'transport layer did not produce a status payload', null, null);
  const value = status.value ?? {};
  const osVersion = String(value.os?.version ?? '');
  const evidence = {
    ready: value.ready ?? null,
    message: value.message ?? null,
    state: value.state ?? null,
    device: value.device ?? null,
    os: value.os ?? null,
    wifiIp: value.ios?.ip ?? null,
    build: value.build ?? null,
  };
  if (value.ready === true) {
    return gate('wda_status', PASS, null,
      `WDA ready; device=${evidence.device ?? 'unknown'} ios=${osVersion || 'unknown'} wda=${evidence.build?.version ?? 'unknown'}`,
      null, evidence);
  }
  return gate('wda_status', FAIL, 'WDA_NOT_READY', `WDA answered but ready=${String(value.ready)}`, 'Restart the WDA runner on the device and retry.', evidence);
}

async function layerScreenInfo(base, opts) {
  const result = await wda(base, 'GET', '/wda/screen', undefined, opts.timeoutMs);
  if (!result.ok) {
    return gate('screen_info', UNKNOWN, 'UNSUPPORTED_ROUTE',
      `/wda/screen unavailable (${wdaError(result)}) - older WDA build; screen metrics will come from the screenshot instead`,
      null, { httpStatus: result.httpStatus ?? null });
  }
  const value = result.json?.value ?? {};
  return gate('screen_info', PASS, null,
    `screen=${value.width}x${value.height} scale=${value.scale} statusBar=${value.statusBarSize?.width}x${value.statusBarSize?.height}`,
    null, value);
}

const SESSION_CAPABILITIES = (testUrl, supportsInitialUrl) => {
  const caps = {
    bundleId: SAFARI_BUNDLE_ID,
    shouldWaitForQuiescence: true,
    appLaunchStateTimeoutSec: 60,
    forceAppLaunch: true,
  };
  if (supportsInitialUrl) caps.initialUrl = testUrl;
  return caps;
};

async function layerSession(base, opts, osVersion) {
  const supportsInitialUrl = osVersion ? compareVersions(osVersion, '16.4') >= 0 : true;
  const caps = SESSION_CAPABILITIES(opts.testUrl, supportsInitialUrl);
  const variants = [
    { name: 'w3c-alwaysMatch', body: { capabilities: { alwaysMatch: caps } } },
    { name: 'flat-capabilities', body: { capabilities: caps } },
    { name: 'legacy-desiredCapabilities', body: { desiredCapabilities: caps } },
  ];
  const attempts = [];

  for (const variant of variants) {
    const result = await wda(base, 'POST', '/session', variant.body, Math.max(opts.timeoutMs, 60000));
    const sessionId = result.json?.value?.sessionId ?? result.json?.sessionId ?? null;
    attempts.push({
      variant: variant.name,
      ok: result.ok,
      httpStatus: result.httpStatus ?? null,
      sessionIdShape: result.json?.value?.sessionId ? 'value.sessionId' : (result.json?.sessionId ? 'sessionId' : null),
      message: result.ok ? null : wdaError(result),
      ms: result.ms,
    });
    if (result.ok && sessionId) {
      return {
        session: gate('session', PASS, null,
          `Safari session created via ${variant.name} payload (sessionId shape: ${attempts.at(-1).sessionIdShape}); initialUrl ${supportsInitialUrl ? 'applied at launch' : 'unsupported below iOS 16.4'}`,
          null, { attempts, capabilities: caps, osVersion: osVersion ?? null }),
        sessionId,
      };
    }
  }

  return {
    session: gate('session', FAIL, 'SESSION_CREATE_FAILED',
      attempts.map((a) => `${a.variant} -> ${a.message}`).join(' | '),
      'Safari could not be attached. On a locked/untrusted device this fails here; verify Developer Mode, UI Automation, and that the WDA runner is signed with a trusted provisioning profile.',
      { attempts, capabilities: caps, osVersion: osVersion ?? null }),
    sessionId: null,
  };
}

async function readScreenshot(base, sessionId, opts) {
  const result = await wda(base, 'GET', `/session/${sessionId}/screenshot`, undefined, opts.timeoutMs);
  if (!result.ok) return { ok: false, error: wdaError(result), result };
  const base64 = result.json?.value;
  if (typeof base64 !== 'string' || !base64.length) return { ok: false, error: 'empty screenshot payload', result };
  const buffer = Buffer.from(base64, 'base64');
  const info = pngInfo(buffer);
  if (!info) return { ok: false, error: 'payload is not a PNG', result };
  return { ok: true, buffer, info, result };
}

async function layerNavigate(base, sessionId, opts, usedInitialUrl) {
  const result = await wda(base, 'POST', `/session/${sessionId}/url`, { url: opts.testUrl }, opts.timeoutMs);
  if (!result.ok) {
    return gate('navigate', FAIL, 'NAVIGATE_FAILED', `/session/:id/url -> ${wdaError(result)}`,
      'POST /url is a deep-link open. If it fails, check that Safari is not blocked by a system dialog on the device screen.', { httpStatus: result.httpStatus });
  }
  return gate('navigate', PASS, null,
    `POST /session/:id/url accepted in ${result.ms} ms (${usedInitialUrl ? 'page already loaded via initialUrl at session start; ' : ''}deep-link open, no load wait by design)`,
    null, { httpStatus: result.httpStatus, urlReadback: 'out_of_scope: WDA exposes no GET /url on the no-Appium path' });
}

async function layerSettle(base, sessionId, opts) {
  const samples = [];
  let previous = null;
  for (let attempt = 1; attempt <= opts.settleAttempts; attempt += 1) {
    const shot = await readScreenshot(base, sessionId, opts);
    if (!shot.ok) return gate('settle', UNKNOWN, 'SCREENSHOT_FAILED', `settle sampling failed: ${shot.error}`, 'Screenshots are the load proxy on this path; fix screenshot first.', { samples });
    const size = shot.buffer.length;
    samples.push(size);
    if (previous !== null) {
      const delta = Math.abs(size - previous) / Math.max(previous, 1);
      if (delta <= 0.01) {
        return gate('settle', PASS, null, `render stable after ${attempt} samples (delta ${(delta * 100).toFixed(2)}%)`,
          null, { samples, heuristic: 'screenshot byte-size stability; the no-Appium path has no network-idle signal' });
      }
    }
    previous = size;
    await sleep(opts.settleIntervalMs);
  }
  return gate('settle', UNKNOWN, 'SETTLE_UNSTABLE',
    `render did not stabilize within ${opts.settleAttempts} samples (bytes: ${samples.join(', ')})`,
    'A continuously animating page never stabilizes byte-wise; treat as informational unless the screenshot below looks wrong.',
    { samples });
}

async function layerScreenshot(base, sessionId, opts) {
  const shot = await readScreenshot(base, sessionId, opts);
  if (!shot.ok) {
    return {
      screenshot: gate('screenshot', FAIL, 'SCREENSHOT_FAILED', shot.error,
        'Real-device screenshots come from XCTest in-process; a failure here usually means the session is gone or the device is locked.', null),
      artifact: null,
    };
  }
  fs.mkdirSync(opts.outDir, { recursive: true });
  const artifact = path.join(opts.outDir, `wda-screenshot-${new Date().toISOString().replace(/[:.]/g, '-')}.png`);
  fs.writeFileSync(artifact, shot.buffer);
  return {
    screenshot: gate('screenshot', PASS, null,
      `PNG ${shot.info.width}x${shot.info.height} (${shot.buffer.length} bytes) written to ${artifact}`,
      null, { width: shot.info.width, height: shot.info.height, bytes: shot.buffer.length, artifact }),
    artifact,
  };
}

async function layerTouch(base, sessionId, opts) {
  const screen = await wda(base, 'GET', '/wda/screen', undefined, opts.timeoutMs);
  const width = Number(screen.json?.value?.width) || 0;
  const height = Number(screen.json?.value?.height) || 0;
  if (!width || !height) {
    return gate('touch', UNKNOWN, 'UNSUPPORTED_ROUTE', 'cannot resolve screen size for a tap target', null, null);
  }
  const before = await readScreenshot(base, sessionId, opts);
  const x = Math.round(width / 2);
  const y = Math.round(height * 0.35);
  const actions = {
    actions: [{
      type: 'pointer',
      id: 'finger1',
      parameters: { pointerType: 'touch' },
      actions: [
        { type: 'pointerMove', duration: 0, x, y },
        { type: 'pointerDown', button: 0 },
        { type: 'pause', duration: 80 },
        { type: 'pointerUp', button: 0 },
      ],
    }],
  };
  const tap = await wda(base, 'POST', `/session/${sessionId}/actions`, actions, opts.timeoutMs);
  if (!tap.ok) {
    return gate('touch', FAIL, 'TOUCH_FAILED', `W3C /actions -> ${wdaError(tap)}`, 'Native touch synthesis needs UI Automation enabled on the device.', { httpStatus: tap.httpStatus });
  }
  await sleep(700);
  const after = await readScreenshot(base, sessionId, opts);
  const changed = before.ok && after.ok ? !before.buffer.equals(after.buffer) : null;
  return gate('touch', changed === null ? UNKNOWN : PASS, null,
    `W3C /actions accepted at (${x}, ${y}); pixels ${changed === null ? 'not comparable' : changed ? 'changed (native touch reached Safari)' : 'identical (tap may have hit inert content)'}`,
    changed === false ? 'An identical frame is not proof of failure - tap a link or button in the test page to make the check discriminating.' : null,
    { x, y, pixelsChanged: changed });
}

async function layerCleanup(base, sessionId, opts) {
  if (opts.skipCleanup) return gate('cleanup', UNKNOWN, null, 'skipped (--skip-cleanup): session left open on purpose', null, { sessionId });
  const result = await wda(base, 'DELETE', `/session/${sessionId}`, undefined, opts.timeoutMs);
  if (!result.ok) {
    return gate('cleanup', FAIL, 'CLEANUP_FAILED', `DELETE /session/:id -> ${wdaError(result)}`,
      'A leaked session is not fatal for the spike, but the next run will kill it anyway (WDA kills the active session on POST /session).',
      { httpStatus: result.httpStatus });
  }
  return gate('cleanup', PASS, null, `session ${sessionId} released`, null, { sessionId });
}

// ---------------------------------------------------------------- driver

async function main() {
  let opts;
  try {
    opts = parseArgs(process.argv.slice(2));
  } catch (err) {
    console.error(`spike: ${err.message}`);
    console.error(HELP);
    process.exit(2);
  }
  if (opts.help) {
    console.log(HELP.trim());
    return;
  }

  const startedAt = new Date().toISOString();
  const gates = [];
  const record = (entry) => { gates.push(entry); return entry; };
  const emit = (entry) => {
    const tag = entry.status === PASS ? 'PASS' : entry.status === FAIL ? 'FAIL' : 'UNKN';
    console.log(`[${tag}] ${entry.id.padEnd(12)} ${entry.detail}`);
    if (entry.action && entry.status !== PASS) console.log(`       action: ${entry.action}`);
  };

  console.log(`AntiFan Phase 0 spike - test page: ${opts.testUrl}`);
  console.log(`candidates: ${opts.candidates.join(', ')}`);
  console.log('');

  const usbPresence = record(await layerUsbPresence(opts));
  emit(usbPresence);

  const host = record(await layerHostService(opts, usbPresence.evidence));
  emit(host);

  let transportBase = null;
  let status = null;
  let sessionId = null;
  let screenshotArtifact = null;

  const transport = await layerTransport(opts);
  record(transport.transport);
  emit(transport.transport);
  transportBase = transport.base;
  status = transport.status;

  if (host.status === FAIL && transport.transport.status === PASS) {
    // A transport answered (for example the phone's own Wi-Fi IP), so host usbmuxd
    // reachability is diagnostic colour, not a failure.
    host.status = UNKNOWN;
    host.code = null;
    host.action = null;
    host.detail += ' - informational: a transport answered without host usbmuxd';
  }

  if (!transportBase) {
    record(gate('wda_status', UNKNOWN, 'WDA_NOT_REACHED', 'skipped: no WDA transport', null, null));
    record(gate('session', UNKNOWN, 'SESSION_NOT_CREATED', 'skipped: no WDA transport', null, null));
    record(gate('navigate', UNKNOWN, 'NAVIGATE_FAILED', 'skipped: no WDA transport', null, null));
    record(gate('screenshot', UNKNOWN, 'SCREENSHOT_FAILED', 'skipped: no WDA transport', null, null));
    record(gate('cleanup', UNKNOWN, 'CLEANUP_FAILED', 'skipped: no WDA transport', null, null));
    return finish(opts, startedAt, gates, null, null);
  }

  const wdaStatus = record(layerWdaStatus(status));
  emit(wdaStatus);
  record(await layerScreenInfo(transportBase, opts)).status !== undefined
    ? emit(gates.at(-1))
    : null;

  const osVersion = status?.value?.os?.version ? String(status.value.os.version) : null;
  const created = await layerSession(transportBase, opts, osVersion);
  record(created.session);
  emit(created.session);
  sessionId = created.sessionId;

  if (!sessionId) {
    record(gate('navigate', UNKNOWN, 'NAVIGATE_FAILED', 'skipped: no session', null, null));
    record(gate('screenshot', UNKNOWN, 'SCREENSHOT_FAILED', 'skipped: no session', null, null));
    record(gate('cleanup', UNKNOWN, 'CLEANUP_FAILED', 'skipped: no session', null, null));
    return finish(opts, startedAt, gates, null, null);
  }

  const usedInitialUrl = Boolean(created.session.evidence?.capabilities?.initialUrl);
  const navigate = record(await layerNavigate(transportBase, sessionId, opts, usedInitialUrl));
  emit(navigate);

  const settle = record(await layerSettle(transportBase, sessionId, opts));
  emit(settle);

  const shot = await layerScreenshot(transportBase, sessionId, opts);
  record(shot.screenshot);
  emit(shot.screenshot);
  screenshotArtifact = shot.artifact;

  if (opts.touch) {
    const touch = record(await layerTouch(transportBase, sessionId, opts));
    emit(touch);
  }

  const cleanup = record(await layerCleanup(transportBase, sessionId, opts));
  emit(cleanup);

  return finish(opts, startedAt, gates, screenshotArtifact, transportBase);
}

function finish(opts, startedAt, gates, screenshotArtifact, transportBase) {
  const required = ['transport', 'session', 'navigate', 'screenshot'];
  const failed = gates.filter((g) => required.includes(g.id) && g.status === FAIL);
  const pending = gates.filter((g) => required.includes(g.id) && g.status === UNKNOWN);
  const transportGate = gates.find((g) => g.id === 'transport');
  const transportReached = transportGate?.status === PASS;

  // A transport nobody answers on a host with no device attached is not evidence that the
  // hardware path is unusable - it is an environment that is not set up yet. Only a reachable
  // device that then fails a required layer, or a port that answers but is not WDA, is NO_GO.
  let verdict;
  let reason = null;
  if (!failed.length && !pending.length) {
    verdict = 'GO';
  } else if (!transportReached && !transportGate?.evidence?.mismatch) {
    verdict = 'INCONCLUSIVE';
    reason = 'NO_DEVICE_TRANSPORT_REACHABLE';
  } else if (!transportReached) {
    verdict = 'NO_GO';
    reason = 'TRANSPORT_NOT_WDA';
  } else {
    verdict = 'NO_GO';
    reason = (failed[0] ?? pending[0])?.code ?? null;
  }

  const report = {
    spike: 'antifan-phase0-real-iphone',
    startedAt,
    finishedAt: new Date().toISOString(),
    verdict,
    reason,
    transport: transportBase,
    testUrl: opts.testUrl,
    deviceSerial: gates.find((entry) => entry.id === 'usb_presence')?.evidence?.serial ?? null,
    automationReady: verdict === 'GO',
    inspectionReady: false,
    gates,
    outOfScope: [
      'DOM / CSS / JS / console / network (needs Web Inspector + Remote Automation: Phase 3)',
      'URL readback (WDA exposes no GET /url without Appium)',
    ],
    artifacts: { screenshot: screenshotArtifact, report: path.join(opts.outDir, 'spike-iphone-report.json') },
  };

  fs.mkdirSync(opts.outDir, { recursive: true });
  fs.writeFileSync(report.artifacts.report, `${JSON.stringify(report, null, 2)}\n`);

  console.log('');
  if (opts.json) {
    console.log(JSON.stringify(report, null, 2));
  } else {
    console.log(`evidence: ${report.artifacts.report}`);
    if (screenshotArtifact) console.log(`screenshot: ${screenshotArtifact}`);
  }
  console.log(`VERDICT: ${verdict}`);

  process.exitCode = verdict === 'GO' ? 0 : verdict === 'NO_GO' ? 1 : 2;
  return report;
}

await main();
