/**
 * RPC surface coverage gate.
 *
 * The failure this exists to prevent is silent, not loud: the GUI calls `tm.someMethod()`, the proxy
 * has no such method (a TypeError at runtime) or has one the host never dispatched (UNKNOWN_METHOD
 * over the wire, surfacing as a missing sidebar entry rather than an error). Neither shows up in a
 * typecheck of the daemon alone, and both appear only when a user clicks the thing.
 *
 * Two passes, both required:
 *
 *   1. STATIC — read the GUI sources, collect every method actually called on a TerminalManager
 *      instance, and require each one to be either implemented by the proxy or listed below with a
 *      reason. A newly added call site therefore fails this gate until the surface follows.
 *
 *   2. LIVE — boot a real staged host and call every proxy method once, asserting the reply is a
 *      real answer and not `UNKNOWN_METHOD`. Pass 1 proves the method exists; pass 2 proves the
 *      daemon dispatches it. Methods are exercised against throwaway sessions so the probe leaves no
 *      terminal behind, and `shutdownHost` runs last, on its own host.
 *
 * Run: node scripts/probe-rpc-surface-coverage.cjs
 */
'use strict';

const path = require('node:path');
const fs = require('node:fs');
const os = require('node:os');

const ROOT = path.resolve(__dirname, '..');
const COMPILED = path.join(ROOT, '.compiled', 'src', 'main', 'terminal-daemon');
const probeDir = process.env.PROBE_DIR || path.join(os.tmpdir(), 'antifan-rpc-coverage');

process.env.ANTIFAN_DATA_ROOT = probeDir;
process.env.ANTIFAN_CONFIG_DIR = probeDir;

const { execFileSync } = require('node:child_process');
const { ensureDaemon } = require(path.join(COMPILED, 'daemon-spawner.js'));
const { DaemonClient, DaemonTerminalProxy } = require(path.join(COMPILED, 'daemon-client.js'));
const { HOST_METHOD } = require(path.join(COMPILED, 'protocol.js'));

const delay = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * Methods a GUI call site may use that are deliberately NOT RPCs.
 *
 * Every entry needs a reason: an allowlist without one is just a place to hide drift.
 */
const LOCAL_ONLY = {
  getInstance: 'static accessor, not an instance method',
  dispose: 'local teardown of the proxy/manager handle',
  on: 'EventEmitter subscription — the proxy re-emits the daemon broadcasts under the same names',
  off: 'EventEmitter',
  once: 'EventEmitter',
  addListener: 'EventEmitter',
  removeListener: 'EventEmitter',
  removeAllListeners: 'EventEmitter',
  emit: 'EventEmitter',
  listenerCount: 'EventEmitter',
  kill: 'kills every PTY on the host — reachable only as the explicit quit-everything action (proxy: shutdownHost)',
  setBridgeEndpoint: 'the host pins its own PTY children to its own bridge; the GUI has no say over it',
  pauseSession: 'PTY backpressure, gated behind BRIDGE_PTY_BACKPRESSURE and owned by the writer',
  getBridgeEndpoint: 'host-local state',
};

/** GUI files that talk to the terminal manager. */
const GUI_SOURCES = [
  'src/main/browser/native-tab-host.ts',
  'src/main/bridge/bridge-server.ts',
  'src/main/browser/annotation-dispatch.ts',
  'src/main/browser/app-menu.ts',
  'src/main/index.ts',
];

/**
 * Members that actually exist on TerminalManager, read from source.
 *
 * Without this, the collector is a name matcher: any local variable that happens to share a name
 * with a manager holder makes `x.trim()` and `session.fromPartition()` look like manager calls, and
 * the gate drowns in false positives until someone stops reading it. Parsed from source rather than
 * required, because requiring terminal-manager.js pulls in node-pty — a native addon built for
 * Electron's ABI, which plain node cannot load.
 */
function collectManagerMembers() {
  const text = fs.readFileSync(path.join(ROOT, 'src/main/browser/terminal-manager.ts'), 'utf8');
  const members = new Set();
  for (const m of text.matchAll(/^\s{0,4}(?:(?:public|private|protected|static)\s+)*(?:async\s+)?(?:get\s+|set\s+)?([A-Za-z_$][\w$]*)\s*\(/gm)) {
    members.add(m[1]);
  }
  for (const m of text.matchAll(/^\s{0,4}(?:(?:public|private|protected)\s+)?(?:readonly\s+)?([A-Za-z_$][\w$]*)\s*[:=]/gm)) {
    members.add(m[1]);
  }
  return members;
}

/** Collect every method name called on a TerminalManager instance across the GUI sources. */
function collectGuiCalls() {
  const managerMembers = collectManagerMembers();
  const calls = new Map(); // method -> Set("file:line")
  for (const rel of GUI_SOURCES) {
    const abs = path.join(ROOT, rel);
    if (!fs.existsSync(abs)) continue;
    const text = fs.readFileSync(abs, 'utf8');

    // Identifiers that hold a manager instance: `const tm = TerminalManager.getInstance()`
    const holders = new Set();
    for (const m of text.matchAll(/(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=\s*TerminalManager\.getInstance\(\)/g)) {
      holders.add(m[1]);
    }
    // `this.tm = TerminalManager.getInstance()` — property holders too.
    for (const m of text.matchAll(/this\.([A-Za-z_$][\w$]*)\s*=\s*TerminalManager\.getInstance\(\)/g)) {
      holders.add(`this.${m[1]}`);
    }
    if (holders.size === 0 && !text.includes('TerminalManager')) continue;

    const patterns = [
      /\bTerminalManager\.getInstance\(\)\s*\??\.\s*([A-Za-z_$][\w$]*)\s*\(/g,
      ...[...holders].map(
        (h) => new RegExp(`\\b${h.replace('.', '\\.')}\\s*\\??\\.\\s*([A-Za-z_$][\\w$]*)\\s*\\(`, 'g'),
      ),
    ];
    for (const p of patterns) {
      for (const m of text.matchAll(p)) {
        const name = m[1];
        // Keep EventEmitter subscriptions (a real part of the consumed surface) and real manager
        // members; drop everything else as a name collision on an unrelated object.
        if (!managerMembers.has(name) && !LOCAL_ONLY[name]) continue;
        const line = text.slice(0, m.index).split('\n').length;
        if (!calls.has(name)) calls.set(name, new Set());
        calls.get(name).add(`${rel}:${line}`);
      }
    }
  }
  return calls;
}

function alive(pid) {
  try { process.kill(pid, 0); return true; } catch { return false; }
}

function killTree(pid) {
  try { execFileSync('taskkill', ['/pid', String(pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' }); } catch { /* gone */ }
}

async function main() {
  const failures = [];
  const lines = [];
  // Raw-dispatch frames the daemon answered with `success:false` and no reason: dispatch is proven
  // (a missing handler answers UNKNOWN_METHOD), the handler simply reported "not applied" for the
  // deliberately generic payload. Reported as evidence, not as a failure.
  const answeredFalse = [];

  // ---- Pass 1: static coverage ---------------------------------------------------------------
  const proxyMethods = new Set(
    Object.getOwnPropertyNames(DaemonTerminalProxy.prototype).filter(n => n !== 'constructor'),
  );
  const guiCalls = collectGuiCalls();

  lines.push(`GUI call sites reference ${guiCalls.size} distinct manager methods.`);
  lines.push('');
  lines.push('method                 | proxy       | call sites');
  lines.push('-----------------------|-------------|-----------');

  for (const [method, sites] of [...guiCalls].sort()) {
    const covered = proxyMethods.has(method);
    const allow = LOCAL_ONLY[method];
    const verdict = covered ? 'ok' : (allow ? 'local-only' : 'MISSING');
    if (!covered && !allow) {
      failures.push(`static: GUI calls tm.${method}() at ${[...sites].join(', ')} but the proxy has no such method`);
    }
    lines.push(`${method.padEnd(22)} | ${verdict.padEnd(11)} | ${sites.size}`);
  }

  // The reverse direction: proxy methods the daemon never dispatches answer UNKNOWN_METHOD.
  // Pass 2 proves dispatch by calling each one, so no separate source scan is needed here.

  // ---- Pass 2: live dispatch ------------------------------------------------------------------
  const exercised = [];
  const exercisedCalls = new Set();
  let hostPid = 0;
  let shutdownHostPid = 0;

  try {
    fs.rmSync(probeDir, { recursive: true, force: true });
    fs.mkdirSync(probeDir, { recursive: true });
    try {
      execFileSync(process.execPath, [path.join(ROOT, 'scripts', 'stage-daemon-host.mjs'), '--json'], {
        cwd: ROOT, stdio: ['ignore', 'pipe', 'pipe'], env: { ...process.env, ANTIFAN_DATA_ROOT: probeDir },
      });
    } catch (err) {
      const stderr = err && err.stderr ? String(err.stderr).trim() : '';
      throw new Error(`staging failed: ${stderr || (err && err.message ? err.message : err)}`);
    }

    const spawned = await ensureDaemon({ cwd: probeDir });
    if (spawned.mode === 'in-process') throw new Error(`no host: ${spawned.reason}`);
    hostPid = spawned.handle.pid;

    const client = new DaemonClient({ port: spawned.handle.port, token: spawned.handle.token });
    const proxy = new DaemonTerminalProxy({ port: spawned.handle.port, token: spawned.handle.token });
    await proxy.connect();
    exercisedCalls.add('connect');
    exercisedCalls.add('wireEvents'); // internal: runs as part of connect()

    await proxy.startTerminal(probeDir);
    const list = await proxy.listSessions();
    if (!Array.isArray(list) || list.length === 0) throw new Error('host reported no sessions after startTerminal');
    const mainId = await proxy.getActiveSessionId();
    await proxy.waitReady(mainId, 20000);

    const record = async (name, fn) => {
      try {
        const value = await fn();
        exercisedCalls.add(name.replace(/\(.*\)$/, ''));
        exercised.push({ name, ok: true, value: typeof value === 'object' ? '[object]' : value });
        return value;
      } catch (err) {
        exercisedCalls.add(name.replace(/\(.*\)$/, ''));
        const message = String(err && err.message ? err.message : err);
        exercised.push({ name, ok: false, error: message });
        failures.push(`live: proxy.${name}() failed — ${message}`);
        return undefined;
      }
    };

    await record('ping', () => proxy.ping());
    await record('startTerminal', () => proxy.startTerminal(probeDir));
    await record('waitReady', () => proxy.waitReady(mainId, 20000));
    await record('getActiveSessionId', () => proxy.getActiveSessionId());
    await record('getCurrentCwd', () => proxy.getCurrentCwd());
    await record('getStats', () => proxy.getStats());
    await record('getDiagnostics', () => proxy.getDiagnostics());
    await record('getSessionState', () => proxy.getSessionState());
    await record('getSubscribers', () => proxy.getSubscribers());
    await record('listSessions', () => proxy.listSessions());

    // getSession is the liveness oracle. Its contract is scalars WITHOUT a buffer, because ~25 call
    // sites use it as a truthiness test; the buffer is opt-in. Both halves are asserted here, since a
    // regression that starts shipping megabytes per check would otherwise never be noticed.
    const session = await record('getSession', () => proxy.getSession(mainId));
    if (session && 'buffer' in session) {
      failures.push('live: getSession() returned a buffer without includeBuffer — liveness checks would ship the transcript');
    }
    if (!session || session.id !== mainId) {
      failures.push(`live: getSession() did not return the requested session (got ${session ? session.id : 'undefined'})`);
    }
    const withBuffer = await record('getSession(includeBuffer)', () => proxy.getSession(mainId, { includeBuffer: true }));
    if (withBuffer && !('buffer' in withBuffer)) {
      failures.push('live: getSession({includeBuffer:true}) omitted the buffer');
    }
    await record('getSession(missing id)', () => proxy.getSession('terminal-does-not-exist'));

    await record('getFullBuffer', () => proxy.getFullBuffer(mainId));
    await record('getTerminalDelta', () => proxy.getTerminalDelta(mainId, Number(session?.sessionGeneration) || 1, 0));
    await record('captureBaselineSeq', () => proxy.captureBaselineSeq(mainId));
    await record('syncTerminalView', () => proxy.syncTerminalView({ sessionId: mainId, knownGeneration: Number(session?.sessionGeneration) || 1, lastAppliedSeq: 0 }));
    await record('write', () => proxy.write(''));
    await record('writeTo', () => proxy.writeTo(mainId, ''));
    await record('sendKey', () => proxy.sendKey('ENTER', mainId));
    await record('resize', () => proxy.resize(120, 30));
    await record('resizeTo', () => proxy.resizeTo(mainId, 120, 30));
    await record('renameSession', () => proxy.renameSession(mainId, 'coverage probe'));
    await record('setCategory', () => proxy.setCategory(mainId, 'probe'));
    await record('setCapsule', () => proxy.setCapsule('probe-capsule', probeDir, mainId));
    // The ack is the one call whose payload field names cannot be checked by a compile: the host
    // rebuilt an object field by field, so a wrong name (`appliedSeq` for `seq`) recorded 0 forever
    // and no type error appeared. Assert the value lands on the host, not merely that the call
    // returned.
    const ackSeq = 4242;
    const ackGen = Number(session?.sessionGeneration) || 1;
    await record('recordSubscriberAck', () => proxy.recordSubscriberAck({
      rendererInstanceId: 'coverage-probe', sessionId: mainId, generation: ackGen, seq: ackSeq,
    }));
    // Shape first: TerminalManager.getSubscribers() returns an array, so a wrapper object here
    // would silently change what every call site sees when it moves to the proxy.
    const subscribers = await proxy.getSubscribers();
    if (!Array.isArray(subscribers)) {
      failures.push(`live: getSubscribers() returned ${typeof subscribers} instead of an array — the proxy is not faithful to the manager's shape`);
    }
    const ackEntry = Array.isArray(subscribers)
      ? subscribers.find(s => s && s.rendererInstanceId === 'coverage-probe' && s.sessionId === mainId)
      : undefined;
    if (!ackEntry) {
      failures.push('live: recordSubscriberAck() left no subscriber record — the ack was dropped, not recorded');
    } else if (ackEntry.lastAckedSeq !== ackSeq) {
      failures.push(`live: recordSubscriberAck() recorded lastAckedSeq=${ackEntry.lastAckedSeq}, expected ${ackSeq} — payload field names do not match the host's reader`);
    }
    await record('reorderSessions', () => proxy.reorderSessions([mainId]));
    await record('persistSync', () => proxy.persistSync());
    await record('setBridgeEndpoint', () => proxy.setBridgeEndpoint({ port: 1234, host: '127.0.0.1', pid: 1 }));

    // Mutating calls run on a throwaway session so the probe never removes the session it is
    // standing on, and the host is left holding exactly what it started with.
    const scratchId = await record('createSession', () => proxy.createSession(probeDir));
    if (scratchId) {
      await proxy.waitReady(scratchId, 20000).catch(() => undefined);
      const splitId = await record('createSplitSession', () => proxy.createSplitSession(scratchId, probeDir));
      await record('switchSession', () => proxy.switchSession(scratchId));
      if (splitId) await record('closeSplitSession', () => proxy.closeSplitSession(splitId));
      await record('sleepSession', () => proxy.sleepSession(scratchId));
      await record('wakeSession', () => proxy.wakeSession(scratchId));
      await record('closeSession', () => proxy.closeSession(scratchId));
    }
    await record('switchSession(back)', () => proxy.switchSession(mainId));
    await record('restart', () => proxy.restart(probeDir));

    // Dispatch proof for every name in the protocol, including ones with no proxy method yet:
    // calling them raw separates "the daemon does not dispatch this" from "the proxy lacks it".
    const undispatched = [];
    for (const [key, wire] of Object.entries(HOST_METHOD)) {
      if (key === 'shutdown') continue;
      try {
        await client.call(wire, { sessionId: mainId, key: 'ENTER', orderIds: [mainId], capsuleId: 'probe', text: '', cols: 120, rows: 30 });
      } catch (err) {
        const message = String(err && err.message ? err.message : err);
        const envelope = err && typeof err === 'object' ? err.rpcFailure : undefined;
        if (/UNKNOWN_METHOD|Unknown method|not implemented/i.test(message)) {
          undispatched.push(`${key} (${wire})`);
        } else if (envelope && envelope.error === undefined) {
          // An answered frame with no reason string: the handler exists and returned its own
          // boolean verdict ("not applied" for this deliberately generic payload). A missing
          // dispatch answers UNKNOWN_METHOD; a handler that threw answers with a reason.
          answeredFalse.push(`${key} (${wire}) -> ${JSON.stringify(envelope.data)}`);
        } else {
          failures.push(`live: raw dispatch of ${key} (${wire}) failed — ${message}`);
        }
      }
    }
    if (undispatched.length) {
      failures.push(`live: daemon dispatches no handler for: ${undispatched.join(', ')}`);
    }

    client.close();
    proxy.dispose();

    // shutdown kills the host, so it runs last and on a host that nothing else depends on.
    const spawned2 = await ensureDaemon({ cwd: probeDir });
    if (spawned2.mode !== 'in-process') {
      shutdownHostPid = spawned2.handle.pid;
      const proxy2 = new DaemonTerminalProxy({ port: spawned2.handle.port, token: spawned2.handle.token });
      await proxy2.connect();
      await record('shutdownHost', () => proxy2.shutdownHost());
      proxy2.dispose();
      exercisedCalls.add('dispose');
      let exited = false;
      for (let i = 0; i < 40; i++) {
        await delay(250);
        if (!alive(shutdownHostPid)) { exited = true; break; }
      }
      if (!exited) failures.push('live: shutdownHost() answered but the host process is still alive');
    }

    // Every method the GUI consumes must be exercised — an unexercised RPC is an untested RPC. This
    // runs after the shutdown phase, because dispose() and shutdownHost() only complete there.
    // Transport internals are excluded: they are not part of the surface a call site can touch.
    const INTERNAL = new Set(['wireEvents', 'scheduleReconnect']);
    const unexercised = [...proxyMethods].filter(
      n => !INTERNAL.has(n) && !n.startsWith('_') && !exercisedCalls.has(n),
    );
    for (const name of unexercised) {
      failures.push(`live: proxy.${name}() was never exercised by this probe`);
    }

    console.log(lines.join('\n'));
    console.log('');
    console.log('Live dispatch (' + exercised.length + ' calls): ' + exercised.filter(e => e.ok).length + ' ok, ' + exercised.filter(e => !e.ok).length + ' failed');
    if (answeredFalse.length) {
      console.log('');
      console.log('Dispatcher answered "not applied" (' + answeredFalse.length + ') — handler exists, verdict false for the generic payload:');
      for (const line of answeredFalse) console.log(`  - ${line}`);
    }
  } catch (err) {
    failures.push(`probe: ${err && err.stack ? err.stack : err}`);
    console.log(lines.join('\n'));
  } finally {
    if (hostPid && alive(hostPid)) killTree(hostPid);
    if (shutdownHostPid && alive(shutdownHostPid)) killTree(shutdownHostPid);
  }

  if (failures.length) {
    console.log('\nFAILURES:');
    for (const f of failures) console.log(`  - ${f}`);
  }
  console.log(`\nPROBE_RESULT ${JSON.stringify({ ok: failures.length === 0, guiMethods: guiCalls.size, exercised: exercised.length, answeredFalse: answeredFalse.length, failures })}`);
  return failures.length === 0 ? 0 : 1;
}

main().then(code => process.exit(code));
