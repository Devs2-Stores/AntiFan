/**
 * Device surface smoke test — exercises the real control plane, the real device capability family
 * and the real adapter against a WebDriverAgent-contract HTTP fixture.
 *
 * Why a fixture and not the phone: the USB/WDA transport is the only part that needs hardware. The
 * fixture speaks the exact WDA routes and payload shapes verified from WebDriverAgent source, so
 * everything above the socket — policy freeze, device authorization, session generation, artifact
 * staging, request wire format — is exercised for real.
 *
 * Run: node scratch/device-surface-smoke.mjs
 */
import { createRequire } from 'node:module';
import { createServer } from 'node:http';
import { deflateSync } from 'node:zlib';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import * as path from 'node:path';

const require = createRequire(import.meta.url);
const { ControlPlaneRuntime } = require('../.compiled/src/main/control-plane/control-plane-runtime.js');
const { DeviceManager } = require('../.compiled/src/main/device/device-manager.js');
const { IosDeviceAdapter } = require('../.compiled/src/main/device/ios-device-adapter.js');
const { makeControlPlaneId } = require('../.compiled/src/shared/control-plane-contracts.js');

// Control-plane tenancy ids are validated on construction; mint them the same way the host does.
const PROJECT_ID = makeControlPlaneId('project');
const WORKSPACE_ID = makeControlPlaneId('workspace');
const DEVICE = { deviceNumber: 42, deviceId: '00008101-001234567890001E', name: 'Smoke iPhone', model: 'iPhone15,3', osVersion: '18.5', connection: 'usb' };

// ---------------------------------------------------------------- PNG fixture
const CRC_TABLE = (() => {
  const table = new Int32Array(256);
  for (let n = 0; n < 256; n += 1) {
    let c = n;
    for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c;
  }
  return table;
})();

function crc32(buffer) {
  let c = 0xffffffff;
  for (const byte of buffer) c = CRC_TABLE[(c ^ byte) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function pngChunk(type, data) {
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.length, 0);
  const typeBuffer = Buffer.from(type, 'ascii');
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(Buffer.concat([typeBuffer, data])), 0);
  return Buffer.concat([length, typeBuffer, data, crc]);
}

function makePng(width, height, rgb) {
  const stride = width * 3 + 1;
  const raw = Buffer.alloc(stride * height);
  for (let y = 0; y < height; y += 1) {
    const rowOffset = y * stride;
    raw[rowOffset] = 0;
    for (let x = 0; x < width; x += 1) {
      const offset = rowOffset + 1 + x * 3;
      raw[offset] = rgb[0];
      raw[offset + 1] = rgb[1];
      raw[offset + 2] = rgb[2];
    }
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8;
  ihdr[9] = 2;
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    pngChunk('IHDR', ihdr),
    pngChunk('IDAT', deflateSync(raw)),
    pngChunk('IEND', Buffer.alloc(0)),
  ]);
}

// ---------------------------------------------------------------- WDA fixture
const PNG = makePng(393, 852, [45, 125, 190]);
const requests = [];

function startWdaFixture() {
  const server = createServer((req, res) => {
    let body = '';
    req.on('data', (chunk) => { body += chunk; });
    req.on('end', () => {
      const parsed = body ? JSON.parse(body) : undefined;
      requests.push({ method: req.method, url: req.url, body: parsed });
      const send = (status, payload) => {
        res.writeHead(status, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(payload));
      };
      if (req.url === '/status') {
        return send(200, { value: { ready: true, message: 'WebDriverAgent is ready to accept commands', device: 'iPhone', os: { version: '18.5' }, build: { version: '5.14.2' } } });
      }
      if (req.url === '/wda/screen') {
        return send(200, { value: { width: 1179, height: 2556, scale: 3, statusBarSize: { width: 1179, height: 141 } } });
      }
      if (req.method === 'POST' && req.url === '/session') {
        return send(200, { value: { sessionId: 'smoke-session-1' } });
      }
      if (req.method === 'POST' && /^\/session\/[^/]+\/url$/.test(req.url)) {
        return send(200, { value: null });
      }
      if (req.method === 'GET' && /^\/session\/[^/]+\/screenshot$/.test(req.url)) {
        return send(200, { value: PNG.toString('base64') });
      }
      if (req.method === 'POST' && /^\/session\/[^/]+\/actions$/.test(req.url)) {
        return send(200, { value: null });
      }
      if (req.method === 'GET' && /^\/session\/[^/]+\/element\/active$/.test(req.url)) {
        return send(200, { value: { ELEMENT: 'elem-1' } });
      }
      if (req.method === 'POST' && /^\/session\/[^/]+\/element\/[^/]+\/value$/.test(req.url)) {
        return send(200, { value: null });
      }
      if (req.method === 'DELETE' && /^\/session\/[^/]+$/.test(req.url)) {
        return send(200, { value: null });
      }
      return send(404, { value: { error: 'unknown command', message: `no fixture route for ${req.method} ${req.url}` } });
    });
  });
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve({ server, port: server.address().port })));
}

// ---------------------------------------------------------------- harness
let passed = 0;
const failures = [];

function check(name, condition, detail) {
  if (condition) {
    passed += 1;
    console.log(`  PASS  ${name}`);
    return;
  }
  failures.push(`${name}${detail !== undefined ? ` :: ${JSON.stringify(detail)}` : ''}`);
  console.log(`  FAIL  ${name}${detail !== undefined ? ` :: ${JSON.stringify(detail)}` : ''}`);
}

async function expectError(name, code, run) {
  try {
    const value = await run();
    check(name, false, { expected: code, resolved: value });
  } catch (err) {
    check(name, err?.code === code, { expected: code, actual: err?.code, message: err?.message });
  }
}

async function main() {
  // A hung smoke run is worse than a failing one: it hides whether the surface ever answered. The
  // watchdog turns "no exit" into an explicit failure with the last phase printed.
  const watchdog = setTimeout(() => {
    console.error('\nsmoke watchdog: no completion within 90s; last phase above');
    process.exit(3);
  }, 90_000);
  try {
    await run();
  } finally {
    clearTimeout(watchdog);
  }
}

async function run() {
  const { server, port } = await startWdaFixture();
  const dataRoot = mkdtempSync(path.join(tmpdir(), 'antifan-device-smoke-'));
  const controlPlane = new ControlPlaneRuntime({ dataRoot, projectId: PROJECT_ID, workspaceId: WORKSPACE_ID });
  const lease = controlPlane.getLease();

  const manager = new DeviceManager({ projectId: PROJECT_ID, workspaceId: WORKSPACE_ID, runtimeId: lease.runtimeId, enumerate: async () => [DEVICE] });
  const adapter = new IosDeviceAdapter({ devices: manager, artifacts: controlPlane.artifacts, candidates: [`http://127.0.0.1:${port}`] });
  controlPlane.registerDevice(adapter, manager);

  const context = { lease, leaseToken: lease.token, projectId: PROJECT_ID, workspaceId: WORKSPACE_ID, grant: 'write', runId: 'run-smoke', attemptId: 'attempt-smoke' };
  const call = (name, params = {}, extra = {}) => controlPlane.capabilities.dispatch(name, params, { ...context, ...extra });

  console.log('\n[1] discovery and readiness');
  const devices = await call('device.list');
  check('device.list enumerates the attached device', devices.length === 1 && devices[0].deviceId === DEVICE.deviceId, devices);

  const status = await call('device.status', { deviceId: DEVICE.deviceId });
  check('device.status reports the attachment as passing', status.readiness.physical.status === 'pass', status.readiness.physical);
  check('device.status reports WebDriverAgent as passing', status.readiness.wda.status === 'pass', status.readiness.wda);
  check('device.status declares automation ready', status.readiness.automationReady === true);
  check('device.status never claims inspection readiness without an inspector probe', status.readiness.inspectionReady === false);
  check('device.status leaves unobservable provisioning gates unknown', status.readiness.developerMode.status === 'unknown');
  check('device.status returns a sessionless rebind handle with the attachment epoch', status.target && status.target.deviceEpoch === 1 && !status.target.sessionId, status.target);

  console.log('\n[2] authorization before a session exists');
  await expectError('device.tap is refused while no automation session exists', 'TARGET_REQUIRED', () => call('device.tap', { x: 10, y: 20 }));
  await expectError('device.reload is refused before any url was remembered', 'DEVICE_OPERATION_UNSUPPORTED', () => call('device.open_safari', { deviceId: DEVICE.deviceId }).then(() => call('device.reload')));

  console.log('\n[3] session establishment');
  const target = await call('device.open_safari', { deviceId: DEVICE.deviceId, url: 'https://example.com/landing' });
  check('open_safari binds a session generation', target.sessionId === 'smoke-session-1' && target.sessionGeneration === 1, target);
  check('open_safari reports panel geometry with panel-derived provenance', Math.round(target.viewport.width) === 393 && Math.round(target.viewport.height) === 852 && target.viewportSource === 'panel-derived', target.viewport);
  check('open_safari sends the W3C capability payload for Safari', requests.some((r) => r.method === 'POST' && r.url === '/session' && r.body?.capabilities?.alwaysMatch?.bundleId === 'com.apple.mobilesafari'), requests.filter((r) => r.url === '/session'));

  console.log('\n[4] device operations');
  const screenshot = await call('device.screenshot');
  check('screenshot stages a PNG artifact', screenshot.kind === 'screenshot' && screenshot.mime === 'image/png' && screenshot.byteLength === PNG.length, { kind: screenshot.kind, mime: screenshot.mime, bytes: screenshot.byteLength });
  const tap = await call('device.tap', { x: 120, y: 300 });
  check('tap reports success', tap.ok === true);
  const tapActions = requests.filter((r) => r.url?.endsWith('/actions')).pop();
  check('tap sends a W3C touch pointer sequence at the requested point', tapActions?.body?.actions?.[0]?.actions?.[0]?.x === 120 && tapActions?.body?.actions?.[0]?.actions?.[0]?.y === 300, tapActions?.body);
  const swipe = await call('device.swipe', { x1: 100, y1: 600, x2: 100, y2: 200, durationMs: 250 });
  check('swipe reports success and names the native gesture', swipe.ok === true && /native gesture/.test(String(swipe.note)), swipe);
  const typed = await call('device.type', { text: 'hello' });
  check('type writes into the focused element', typed.ok === true && requests.some((r) => /\/element\/elem-1\/value$/.test(r.url)), typed);
  const waited = await call('device.wait', { type: 'stable', timeoutMs: 5_000 });
  check('wait reports a rendering heuristic rather than a load guarantee', waited.settled === true && /frame size stable/.test(waited.heuristic), waited);
  const navigated = await call('device.navigate', { url: 'https://example.com/landing' });
  check('navigate declares that it never waits for load', navigated.ok === true && /does not wait for load/.test(String(navigated.note)), navigated);
  const reloaded = await call('device.reload');
  check('reload re-opens the remembered url instead of claiming a refresh', reloaded.ok === true && /no refresh route/.test(String(reloaded.note)), reloaded);

  console.log('\n[5] staleness fails closed');
  await expectError('a target from a previous attachment epoch is refused', 'DEVICE_TARGET_STALE', () =>
    call('device.tap', { x: 5, y: 5 }, { deviceTarget: { ...target, deviceEpoch: target.deviceEpoch + 1 } }));
  await expectError('a target from a previous session generation is refused', 'DEVICE_TARGET_STALE', () =>
    call('device.tap', { x: 5, y: 5 }, { deviceTarget: { ...target, sessionGeneration: target.sessionGeneration + 1 } }));
  await expectError('a target owned by another workspace is refused', 'WORKSPACE_MISMATCH', () =>
    call('device.tap', { x: 5, y: 5 }, { deviceTarget: { ...target, workspaceId: 'someone-else' } }));
  const tapAfterRefusals = await call('device.tap', { x: 7, y: 9 });
  check('a live target still runs after refusals', tapAfterRefusals.ok === true);

  console.log('\n[6] transport failure reporting');
  const deadAdapter = new IosDeviceAdapter({ devices: manager, artifacts: controlPlane.artifacts, candidates: ['http://127.0.0.1:1'], defaultTimeoutMs: 800 });
  const deadStatus = await deadAdapter.status(DEVICE.deviceId).catch((err) => ({ threw: err?.code }));
  check('an unreachable WebDriverAgent is reported as a failed gate with an action, not as no device', deadStatus?.readiness?.physical?.status === 'pass' && deadStatus.readiness.wda.status === 'fail' && Boolean(deadStatus.readiness.wda.action), deadStatus?.readiness ?? deadStatus);

  console.log('\n[7] live discovery path (no injected enumerator)');
  // The injected enumerator above proves the surface; this proves the failure path a real host hits
  // first. This machine has no Apple Mobile Device Support, so usbmuxd-absent is the only live
  // discovery path reachable here, and it must surface typed + actionable instead of a raw socket error.
  const bareRuntime = new ControlPlaneRuntime({
    dataRoot: mkdtempSync(path.join(tmpdir(), 'antifan-device-live-')),
    projectId: makeControlPlaneId('project'),
    workspaceId: makeControlPlaneId('workspace'),
  });
  const bareLease = bareRuntime.getLease();
  const bareManager = new DeviceManager({ projectId: bareLease.projectId, workspaceId: bareLease.workspaceId, runtimeId: bareLease.runtimeId });
  const bareAdapter = new IosDeviceAdapter({ devices: bareManager, artifacts: bareRuntime.artifacts, candidates: [`http://127.0.0.1:${port}`] });
  bareRuntime.registerDevice(bareAdapter, bareManager);
  const bareContext = { lease: bareLease, leaseToken: bareLease.token, projectId: bareLease.projectId, workspaceId: bareLease.workspaceId, grant: 'write' };
  const bareCall = (name, params = {}) => bareRuntime.capabilities.dispatch(name, params, bareContext);

  const enumeration = await bareManager.refresh().then(
    (list) => ({ ok: true, count: list.length }),
    (err) => ({ ok: false, code: err?.code, message: err?.message })
  );
  check(
    'live enumeration either lists devices or fails with a typed transport code (never a raw socket error)',
    enumeration.ok === true || enumeration.code === 'DEVICE_TRANSPORT_UNREACHABLE',
    enumeration
  );

  const bareStatus = await bareCall('device.status');
  if (!enumeration.ok) {
    // Host without a USB stack (this machine): the diagnostic capabilities must still answer, and the
    // answer must carry the fix, not a socket error.
    await expectError('device.list reports an unreachable USB stack with a typed code', 'DEVICE_TRANSPORT_UNREACHABLE', () => bareCall('device.list'));
    check('device.status answers with a failed attachment gate and the operator remediation', bareStatus.readiness.physical.status === 'fail' && /Apple Mobile Device Support/.test(String(bareStatus.readiness.physical.action)), bareStatus.readiness.physical);
    check('device.status exposes no fabricated device identity or binding', bareStatus.device === undefined && bareStatus.target === undefined, bareStatus.device);
    await expectError('a target-bound device operation reports the device as not connected', 'DEVICE_NOT_CONNECTED', () => bareCall('device.tap', { x: 1, y: 1 }));
  } else {
    // Host with a working USB stack: no fabricated failure, the same call reports real readiness.
    check('device.status reports readiness instead of failing when the host enumerates devices', bareStatus.readiness.physical.status === 'pass', bareStatus.readiness.physical);
  }

  console.log('\n[8] concurrent operations on one device');
  // Locking at two levels would make the chain await itself and hang; locking only the leaves must
  // still serialize. A fresh runtime is used deliberately: the main runtime already holds a live
  // session, so session reuse would hide the creation race this phase exists to catch.
  const raceRuntime = new ControlPlaneRuntime({
    dataRoot: mkdtempSync(path.join(tmpdir(), 'antifan-device-race-')),
    projectId: makeControlPlaneId('project'),
    workspaceId: makeControlPlaneId('workspace'),
  });
  const raceLease = raceRuntime.getLease();
  const raceManager = new DeviceManager({ projectId: raceLease.projectId, workspaceId: raceLease.workspaceId, runtimeId: raceLease.runtimeId, enumerate: async () => [DEVICE] });
  const raceAdapter = new IosDeviceAdapter({ devices: raceManager, artifacts: raceRuntime.artifacts, candidates: [`http://127.0.0.1:${port}`] });
  raceRuntime.registerDevice(raceAdapter, raceManager);
  const raceContext = { lease: raceLease, leaseToken: raceLease.token, projectId: raceLease.projectId, workspaceId: raceLease.workspaceId, grant: 'write' };
  const raceCall = (name, params = {}) => raceRuntime.capabilities.dispatch(name, params, raceContext);

  const sessionsBefore = requests.filter((r) => r.method === 'POST' && r.url === '/session').length;
  const [firstOpen, secondOpen] = await Promise.all([
    raceCall('device.open_safari', { deviceId: DEVICE.deviceId }),
    raceCall('device.open_safari', { deviceId: DEVICE.deviceId }),
  ]);
  const created = requests.filter((r) => r.method === 'POST' && r.url === '/session').length - sessionsBefore;
  check('two simultaneous session establishments create exactly one WebDriverAgent session', created === 1, { created, sessionsBefore });
  check(
    'both simultaneous callers receive the same live session and generation',
    firstOpen.sessionId === secondOpen.sessionId && firstOpen.sessionGeneration === secondOpen.sessionGeneration,
    { first: firstOpen.sessionId, second: secondOpen.sessionId }
  );
  const [tapA, tapB] = await Promise.all([raceCall('device.tap', { x: 11, y: 22 }), raceCall('device.tap', { x: 33, y: 44 })]);
  check('concurrent device operations both complete instead of deadlocking on the per-device chain', tapA.ok === true && tapB.ok === true, { tapA, tapB });
  const [shot, settled] = await Promise.all([raceCall('device.screenshot'), raceCall('device.wait', { type: 'stable', timeoutMs: 3_000 })]);
  check('a mixed concurrent screenshot/wait pair completes on the serialized chain', shot.kind === 'screenshot' && settled.settled === true, { kind: shot.kind, settled: settled.settled });

  server.closeAllConnections?.();
  server.close();
  console.log(`\n${passed} passed, ${failures.length} failed`);
  if (failures.length) {
    for (const failure of failures) console.log(`  - ${failure}`);
  }
  // The control plane owns background timers (lease renewal, ledger maintenance); a smoke harness
  // must end the process deterministically rather than waiting for those handles to drain.
  process.exit(failures.length ? 1 : 0);
}

main().catch((err) => {
  console.error('smoke crashed:', err);
  // Never hang on a crash: the control plane keeps background handles alive.
  process.exit(1);
});
