/**
 * Terminal Host daemon entry — owns the PTYs so a GUI restart cannot kill them.
 *
 * Runs under Electron's Node runtime (`ELECTRON_RUN_AS_NODE=1`) from a staged directory outside the
 * dev workspace. It must never execute out of `apps/AntiFan/`: a running host holds Windows file
 * locks on `node-pty`'s native binaries, which makes the next `npm run compile` fail EBUSY during
 * exactly the dogfooding loop this daemon exists to support.
 *
 * Transport and envelope are the GUI bridge's, unchanged — `{id, method, params}` in,
 * `{id, success, data, error}` out, `{event, data}` for pushes — so the GUI's terminal proxy is a
 * drop-in for the in-process `TerminalManager` rather than a second protocol to keep in sync.
 */
import * as fs from 'node:fs';
import * as http from 'node:http';
import * as crypto from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import { WebSocketServer, WebSocket } from 'ws';
import { TerminalManager } from '../browser/terminal-manager';
import { HOST_METHOD, HOST_EVENT } from './protocol';
import type { BridgeRequestPayload, BridgeResponsePayload, BridgeEventPayload } from '../../shared/contracts';

const HOST = '127.0.0.1';

/**
 * ANSI CSI/OSC stripping. Prompt detection must read what the user sees; escape sequences are
 * interleaved through every write and would otherwise defeat an end-anchored match.
 */
const ANSI_RE = /[\u001b\u009b][[()#;?]*(?:[0-9]{1,4}(?:;[0-9]{0,4})*)?[0-9A-ORZcf-nqry=><]/g;

/**
 * A shell is ready to accept input only once it has printed a prompt.
 *
 * ConPTY silently discards input written before the shell reads stdin, and the shell banner is
 * emitted *before* the prompt — so "the PTY exists" and "we saw output" are both false positives.
 * Measured against node-pty 1.1.0: an identical `write` at the same nominal delay is dropped or
 * accepted purely on whether the prompt had appeared. Exported because the GUI proxy gating
 * programmatic input and this host must agree on what "ready" means.
 */
export function shellLooksReady(buffer: string): boolean {
  return SHELL_PROMPT_RE.test(buffer.replace(ANSI_RE, '').slice(-400));
}
const SHELL_PROMPT_RE = /(?:^|\n)[^\n]*[>$#]\s*$/;

function argValue(name: string): string | undefined {
  const idx = process.argv.indexOf(`--${name}`);
  return idx !== -1 ? process.argv[idx + 1] : undefined;
}

const handshakePath = argValue('handshake') || '';
const logPath = argValue('log') || '';
const requestedPort = Number(argValue('port') || process.env.ANTIFAN_TERMINAL_HOST_PORT || 0) || 0;
const startupCwd = argValue('cwd') || process.cwd();
const startPid = process.pid;

/**
 * A spawner that can write to this process's stdin hands the token over a pipe, which never shows
 * up in the process table. The env var stays the primary channel because the WMI escape hatch
 * (`Win32_Process.Create`) passes a command line and no stdin at all, so the token still has to be
 * readable from the environment there.
 *
 * Reads byte by byte: a read that batched ahead would swallow protocol frames a pipe-capable
 * spawner writes right after the credential.
 */
function tokenFromStdin(): string {
  if (process.stdin.isTTY) return '';
  const bytes: number[] = [];
  const one = Buffer.alloc(1);
  for (let i = 0; i < 4096; i++) {
    let read = 0;
    try {
      read = fs.readSync(0, one, 0, 1, null);
    } catch {
      break;
    }
    if (read <= 0) break;
    const byte = one.readUInt8(0);
    if (byte === 10) break;
    bytes.push(byte);
  }
  return Buffer.from(bytes).toString('utf8').trim();
}

const token = process.env.ANTIFAN_TERMINAL_HOST_TOKEN || tokenFromStdin();

function log(message: string): void {
  const line = `[${new Date().toISOString()}] ${message}`;
  if (!logPath) return;
  try {
    fs.appendFileSync(logPath, `${line}\n`);
  } catch {
    // Logging must never take the host down; a detached host has no console to fall back on.
  }
}

function safeEqual(a: string, b: string): boolean {
  // `timingSafeEqual` throws on unequal lengths, so the length check is a precondition, not just
  // a fast path — comparing lengths first is what makes a short token a mismatch instead of a crash.
  const ba = Buffer.from(a);
  const bb = Buffer.from(b);
  return ba.length === bb.length && crypto.timingSafeEqual(ba, bb);
}

function main(): void {
  if (!token) {
    log('refusing to start: no host token (ANTIFAN_TERMINAL_HOST_TOKEN unset and stdin carried no token)');
    process.exit(2);
  }

  const tm = TerminalManager.getInstance();
  if (!tm.startTerminal(startupCwd)) {
    log(`startTerminal failed for cwd=${startupCwd}`);
    process.exit(3);
  }

  const wss = new WebSocketServer({ noServer: true });
  const server = http.createServer((req, res) => {
    // The host is a process control surface, not a web server.
    res.writeHead(404, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ error: 'NOT_FOUND' }));
  });

  function broadcast(event: string, data: unknown): void {
    const frame = JSON.stringify({ event, data } as BridgeEventPayload<unknown>);
    for (const client of wss.clients) {
      if (client.readyState === WebSocket.OPEN) client.send(frame);
    }
  }

  tm.on('data', (payload: { sessionId: string; data: string } | string) => {
    const formatted = typeof payload === 'string'
      ? { sessionId: tm.getActiveSessionId(), data: payload }
      : payload;
    broadcast(HOST_EVENT.data, formatted);
  });

  tm.on('session', (payload: unknown) => {
    broadcast(HOST_EVENT.session, payload);
  });

  // TerminalManager owns the real session lifecycle; the host mirrors those transitions onto the
  // wire so a GUI that attaches later still learns about closes, restarts, wakes, and splits.
  tm.on('session-closed', (payload: unknown) => {
    broadcast(HOST_EVENT.sessionClosed, payload);
  });
  tm.on('session-restarted', (payload: unknown) => {
    broadcast(HOST_EVENT.sessionRestarted, payload);
  });
  tm.on('session-woken', (payload: unknown) => {
    broadcast(HOST_EVENT.sessionWoken, payload);
  });
  tm.on('session-created', (payload: unknown) => {
    broadcast(HOST_EVENT.sessionCreated, payload);
  });

  // Upgrade is the only place the token is checked, so a client that passes it holds an
  // authenticated socket for its lifetime and every later frame can be trusted. The credential
  // must arrive in the header: a query string lands in request logs and network diagnostics.
  server.on('upgrade', (req, socket, head) => {
    const presented = req.headers['x-antifan-token'];
    if (typeof presented !== 'string' || !safeEqual(presented, token)) {
      log(`upgrade rejected: bad token from ${req.socket.remoteAddress}`);
      socket.write('HTTP/1.1 401 Unauthorized\r\nConnection: close\r\n\r\n');
      socket.destroy();
      return;
    }
    wss.handleUpgrade(req, socket, head, (ws) => wss.emit('connection', ws, req));
  });

  wss.on('connection', (ws) => {
    log('client connected');

    ws.on('message', async (raw) => {
      let payload: BridgeRequestPayload;
      try {
        payload = JSON.parse(String(raw)) as BridgeRequestPayload;
      } catch {
        return;
      }
      const { id, method } = payload;
      const p = (payload.params || {}) as Record<string, unknown>;
      const respond = (success: boolean, data?: unknown, error?: string): void => {
        const resp: BridgeResponsePayload = { id, success, data, error };
        if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(resp));
      };

      const clean = method.startsWith('antifan.') ? method.slice(8) : method;
      try {
        switch (clean) {
          case HOST_METHOD.listSessions:
          case 'getTerminalSessions':
            respond(true, { sessions: tm.listSessions(), activeSessionId: tm.getActiveSessionId() });
            break;

          case HOST_METHOD.start: {
            const started = tm.startTerminal(typeof p.cwd === 'string' ? p.cwd : undefined);
            respond(started, { started, sessions: tm.listSessions(), activeSessionId: tm.getActiveSessionId() });
            break;
          }

          case HOST_METHOD.getFullBuffer: {
            const sessionId = String(p.sessionId || tm.getActiveSessionId());
            respond(true, tm.getFullBuffer(sessionId));
            break;
          }

          case HOST_METHOD.getDelta: {
            const sessionId = String(p.sessionId || tm.getActiveSessionId());
            respond(true, tm.getTerminalDelta(sessionId, Number(p.generation) || 0, Math.max(1, Number(p.fromSeq) || 0)));
            break;
          }

          case HOST_METHOD.syncView: {
            respond(true, tm.syncTerminalView({
              sessionId: String(p.sessionId || tm.getActiveSessionId()),
              knownGeneration: Number(p.knownGeneration) || 0,
              lastAppliedSeq: Math.max(0, Number(p.lastAppliedSeq) || 0),
            }));
            break;
          }

          case HOST_METHOD.captureBaseline: {
            const sessionId = String(p.sessionId || tm.getActiveSessionId());
            respond(true, tm.captureBaselineSeq(sessionId));
            break;
          }

          case HOST_METHOD.waitReady: {
            const sessionId = String(p.sessionId || tm.getActiveSessionId());
            const timeoutMs = Number(p.timeoutMs) || 15000;
            respond(true, { ready: await waitForShellReady(tm, sessionId, timeoutMs) });
            break;
          }

          case HOST_METHOD.input: {
            if (typeof p.text !== 'string') {
              respond(false, undefined, 'Missing text in terminalInput');
              break;
            }
            if (typeof p.sessionId === 'string' && p.sessionId) tm.writeTo(p.sessionId, p.text);
            else tm.write(p.text);
            respond(true, { written: true });
            break;
          }

          case HOST_METHOD.sendKey: {
            const sequence = typeof p.sequence === 'string' ? p.sequence : KEY_MAP[String(p.key || '').toLowerCase()];
            if (typeof sequence !== 'string') {
              respond(false, undefined, `Unknown key: ${String(p.key)}`);
              break;
            }
            if (typeof p.sessionId === 'string' && p.sessionId) tm.writeTo(p.sessionId, sequence);
            else tm.write(sequence);
            respond(true, { sent: true, key: String(p.key || '') });
            break;
          }

          case HOST_METHOD.resize: {
            const cols = Number(p.cols) || 80;
            const rows = Number(p.rows) || 24;
            if (typeof p.sessionId === 'string' && p.sessionId) tm.resizeTo(p.sessionId, cols, rows);
            else tm.resize(cols, rows);
            respond(true, { resized: true, cols, rows });
            break;
          }

          case HOST_METHOD.switchSession: {
            const sessionId = String(p.sessionId || '');
            if (!sessionId) {
              respond(false, undefined, 'Missing sessionId');
              break;
            }
            const switched = tm.switchSession(sessionId);
            respond(switched, { switched, activeSessionId: tm.getActiveSessionId() });
            break;
          }

          case HOST_METHOD.newSession: {
            const sessionId = typeof p.parentId === 'string' && p.parentId
              ? tm.createSplitSession(p.parentId, typeof p.cwd === 'string' ? p.cwd : undefined, Number(p.cols) || undefined, Number(p.rows) || undefined)
              : tm.createSession(typeof p.cwd === 'string' ? p.cwd : undefined);
            respond(true, { sessionId, sessions: tm.listSessions(), activeSessionId: tm.getActiveSessionId() });
            break;
          }

          case HOST_METHOD.closeSession: {
            const targetId = String(p.sessionId || tm.getActiveSessionId());
            const closed = await tm.closeSession(targetId);
            respond(closed, { closed, sessions: tm.listSessions(), activeSessionId: tm.getActiveSessionId() });
            break;
          }

          case HOST_METHOD.renameSession: {
            const targetId = String(p.id || p.sessionId || tm.getActiveSessionId());
            const renamed = tm.renameSession(targetId, String(p.name || ''));
            respond(renamed, { renamed, sessions: tm.listSessions() });
            break;
          }

          case HOST_METHOD.sleepSession: {
            const sessionId = String(p.sessionId || '');
            if (!sessionId) {
              respond(false, undefined, 'Missing sessionId');
              break;
            }
            const slept = tm.sleepSession(sessionId);
            respond(slept, { slept, sessions: tm.listSessions(), activeSessionId: tm.getActiveSessionId() });
            break;
          }

          case HOST_METHOD.setCategory: {
            const sessionId = String(p.sessionId || '');
            if (!sessionId) {
              respond(false, undefined, 'Missing sessionId');
              break;
            }
            const ok = tm.setCategory(sessionId, typeof p.category === 'string' ? p.category : undefined);
            respond(ok, { ok });
            break;
          }

          case HOST_METHOD.getSession: {
            const sessionId = String(p.sessionId || p.id || '');
            if (!sessionId) {
              respond(false, undefined, 'Missing sessionId');
              break;
            }
            // Scalars only. The buffer is intentionally absent so a liveness check cannot pull a
            // multi-MB transcript across the socket; `includeBuffer` exists for callers that really
            // want the transcript and are prepared to pay for it.
            const summary = tm.listSessions().find(s => s.id === sessionId);
            if (!summary) {
              respond(true, { session: null });
              break;
            }
            const { buffer, ...scalars } = summary;
            respond(true, {
              session: p.includeBuffer ? { ...scalars, buffer } : scalars,
            });
            break;
          }

          case HOST_METHOD.getCurrentCwd:
            respond(true, { cwd: tm.getCurrentCwd() });
            break;

          case HOST_METHOD.closeSplitSession: {
            const target = String(p.sessionId || p.parentId || '');
            if (!target) {
              respond(false, undefined, 'Missing sessionId');
              break;
            }
            const closed = await tm.closeSplitSession(target);
            respond(closed, { closed, sessions: tm.listSessions(), activeSessionId: tm.getActiveSessionId() });
            break;
          }

          case HOST_METHOD.reorderSessions: {
            const orderIds = Array.isArray(p.orderIds) ? p.orderIds.map(String) : [];
            const reordered = tm.reorderSessions(orderIds);
            respond(reordered, { reordered, sessions: tm.listSessions() });
            break;
          }

          case HOST_METHOD.wakeSession: {
            const sessionId = String(p.sessionId || p.id || '');
            if (!sessionId) {
              respond(false, undefined, 'Missing sessionId');
              break;
            }
            const woken = tm.wakeSession(sessionId);
            respond(woken, { woken, sessions: tm.listSessions(), activeSessionId: tm.getActiveSessionId() });
            break;
          }

          case HOST_METHOD.setCapsule: {
            const capsuleId = String(p.capsuleId || '');
            if (!capsuleId) {
              respond(false, undefined, 'Missing capsuleId');
              break;
            }
            tm.setCapsule(
              capsuleId,
              typeof p.cwd === 'string' && p.cwd ? p.cwd : undefined,
              typeof p.sessionId === 'string' && p.sessionId ? p.sessionId : undefined,
            );
            respond(true, { sessions: tm.listSessions(), activeSessionId: tm.getActiveSessionId() });
            break;
          }

          case HOST_METHOD.recordSubscriberAck:
            tm.recordSubscriberAck({
              rendererInstanceId: String(p.rendererInstanceId || ''),
              sessionId: String(p.sessionId || ''),
              generation: Number(p.generation) || 0,
              seq: Number(p.seq) || 0,
              role: p.role === 'DOCK' || p.role === 'POPOUT' ? p.role : undefined,
            });
            respond(true, { ok: true });
            break;

          case HOST_METHOD.shutdown: {
            // Only the explicit "quit everything" action reaches here. Cleaning up before exit keeps
            // the invariant that the host is the single writer: the state file is flushed once, by
            // the process that owns it, instead of being left to the next restore.
            respond(true, { shuttingDown: true });
            log('shutdown requested by client');
            try { tm.persistSync(); } catch (err) { log(`persist on shutdown failed: ${String(err)}`); }
            try { await tm.kill(); } catch (err) { log(`kill on shutdown failed: ${String(err)}`); }
            setTimeout(() => process.exit(0), 50).unref?.();
            break;
          }

          case HOST_METHOD.getStats:
            respond(true, tm.getStats());
            break;

          case HOST_METHOD.getDiagnostics:
            respond(true, tm.getDiagnostics());
            break;

          case HOST_METHOD.getSessionState:
            respond(true, tm.getSessionState());
            break;

          case HOST_METHOD.getSubscribers:
            // Raw passthrough, like every sibling handler: TerminalManager.getSubscribers() returns
            // an array, and the proxy is a facade for that method, so wrapping it here would make
            // call sites see a different shape over RPC than in-process.
            respond(true, tm.getSubscribers());
            break;

          case HOST_METHOD.persistSync:
            tm.persistSync();
            respond(true, { persisted: true });
            break;

          case HOST_METHOD.restart: {
            await tm.restart(typeof p.cwd === 'string' ? p.cwd : undefined);
            respond(true, { restarted: true });
            break;
          }

          case HOST_METHOD.hostPing:
            respond(true, { pong: true, pid: process.pid, hostStartPid: startPid });
            break;

          default:
            respond(false, undefined, `UNKNOWN_METHOD: ${clean}`);
        }
      } catch (err) {
        respond(false, undefined, err instanceof Error ? err.message : String(err));
      }
    });

    ws.on('close', () => log('client disconnected'));
  });

  server.listen(requestedPort, HOST, () => {
    const address = server.address();
    const port = typeof address === 'object' && address ? address.port : requestedPort;
    const handshake = {
      pid: process.pid,
      port,
      protocol: 'ws',
      startedAt: Date.now(),
      // The token is persisted so a restarted GUI can re-authenticate to this still-running host —
      // that re-attach is the entire reason the daemon exists. The file lives under the user-private
      // data root, so it is no more exposed than the session state beside it.
      token,
      version: String(process.env.ANTIFAN_TERMINAL_HOST_VERSION || 'dev'),
      sessionId: tm.getActiveSessionId(),
    };
    if (handshakePath) {
      const tmp = `${handshakePath}.${process.pid}.tmp`;
      fs.writeFileSync(tmp, JSON.stringify(handshake, null, 2));
      fs.renameSync(tmp, handshakePath);
    }
    log(`listening on ${HOST}:${port} pid=${process.pid}`);
    console.log(`TERMINAL_HOST_READY ${JSON.stringify(handshake)}`);
  });
}

const KEY_MAP: Record<string, string> = {
  ctrl_c: '\x03',
  ctrl_d: '\x04',
  ctrl_z: '\x1a',
  ctrl_l: '\x0c',
  tab: '\t',
  up: '\x1b[A',
  down: '\x1b[B',
  right: '\x1b[C',
  left: '\x1b[D',
  enter: '\r',
  escape: '\x1b',
  backspace: '\x7f',
  clear: '\x0c',
};

async function waitForShellReady(tm: TerminalManager, sessionId: string, timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      if (shellLooksReady(tm.getFullBuffer(sessionId).buffer)) return true;
    } catch {
      return false;
    }
    await delay(100);
  }
  return false;
}

main();
