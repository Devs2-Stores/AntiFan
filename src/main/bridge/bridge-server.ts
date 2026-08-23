/**
 * AntiFan Browser Desktop — Bridge Server (Extension & IDE Companion)
 * Fast, authenticated local WebSocket RPC server bridging between IDE Extension / Agent and Chromium Desktop.
 * Includes Mobile Remote Companion Web App, Live Viewport streaming, and Terminal RPC.
 */
import { WebSocketServer, WebSocket } from 'ws';
import * as http from 'node:http';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import { randomUUID } from 'node:crypto';
import { NativeTabHost } from '../browser/native-tab-host';
import { TerminalManager } from '../browser/terminal-manager';
import { renderMobileRemoteHtml } from './mobile-remote-html';
import { generateQrSvg } from './qr-generator';
import {
  AntiFanBridgeStatus,
  BridgeRequestPayload,
  BridgeResponsePayload,
  BridgeEventPayload,
  AntiFanPickedElement,
  AntiFanTab,
  ChatMessage,
} from '../../shared/contracts';
import { CapabilityTransportAdapter } from '../tools/capability-transport';
import { CapabilityRequestContext } from '../../shared/control-plane-contracts';
import { BrowserTarget, RuntimeLease } from '../../shared/control-plane-contracts';

export function getLocalLanIps(): string[] {
  const ips: string[] = [];
  const interfaces = os.networkInterfaces();
  for (const name of Object.keys(interfaces)) {
    for (const net of interfaces[name] || []) {
      if (net.family === 'IPv4' && !net.internal) {
        ips.push(net.address);
      }
    }
  }
  if (ips.length === 0) {
    ips.push('127.0.0.1');
  }
  return ips;
}

interface RuntimeBinding {
  lease: RuntimeLease;
  projectId: string;
  workspaceId: string;
  browserTarget?: BrowserTarget;
}

export class BridgeServer {
  private static instance: BridgeServer | null = null;
  private wss: WebSocketServer | null = null;
  private httpServer: http.Server | null = null;
  private clients: Set<WebSocket> = new Set();
  private tabHost: NativeTabHost;
  private isDev: boolean = false;
  private port: number = 20129;
  private token: string = randomUUID();
  private bridgeInfoPath: string;
  private readonly capabilityTransport?: CapabilityTransportAdapter;
  private readonly runtimeBindingProvider?: () => RuntimeBinding;

  constructor(tabHost: NativeTabHost, port = 20129, isDev = false, capabilityTransport?: CapabilityTransportAdapter, runtimeBindingProvider?: () => RuntimeBinding) {
    this.tabHost = tabHost;
    this.isDev = isDev;
    this.port = isDev && port === 20129 ? 20130 : port;

    const configDir = path.join(os.homedir(), '.antifan');
    if (!fs.existsSync(configDir)) {
      try {
        fs.mkdirSync(configDir, { recursive: true });
      } catch {}
    }
    const bridgeFileName = this.isDev ? 'bridge-dev.json' : 'bridge.json';
    this.bridgeInfoPath = path.join(configDir, bridgeFileName);
    this.capabilityTransport = capabilityTransport;
    this.runtimeBindingProvider = runtimeBindingProvider;

    BridgeServer.instance = this;
    this.wireTabHostEvents();
  }

  public static getInstance(): BridgeServer | null {
    return BridgeServer.instance;
  }

  public getRemoteConnectionInfo(): { port: number; token: string; lanIps: string[]; urls: string[]; primaryUrl: string; qrSvg: string } {
    const lanIps = getLocalLanIps();
    const urls = lanIps.map(ip => `http://${ip}:${this.port}/?token=${encodeURIComponent(this.token)}`);
    const primaryUrl = urls[0] || `http://localhost:${this.port}/?token=${encodeURIComponent(this.token)}`;
    const qrSvg = generateQrSvg(primaryUrl);
    return { port: this.port, token: this.token, lanIps, urls, primaryUrl, qrSvg };
  }

  private createHttpHandler(): (req: http.IncomingMessage, res: http.ServerResponse) => void {
    return async (req, res) => {
      const host = req.headers.host || `127.0.0.1:${this.port}`;
      const reqUrl = new URL(req.url || '/', `http://${host}`);
      const pathname = reqUrl.pathname;

      if (pathname === '/status') {
        res.writeHead(200, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' });
        res.end(JSON.stringify(this.getStatus()));
        return;
      }

      if (pathname === '/api/lan-ips' || pathname === '/api/remote-info') {
        const lanIps = getLocalLanIps();
        const urls = lanIps.map(ip => `http://${ip}:${this.port}/?token=${encodeURIComponent(this.token)}`);
        const primaryUrl = urls[0] || `http://localhost:${this.port}/?token=${encodeURIComponent(this.token)}`;
        const qrSvg = generateQrSvg(primaryUrl);
        res.writeHead(200, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' });
        res.end(JSON.stringify({ port: this.port, token: this.token, lanIps, urls, primaryUrl, qrSvg }));
        return;
      }

      if (pathname === '/api/qr') {
        const lanIps = getLocalLanIps();
        const url = `http://${lanIps[0] || '127.0.0.1'}:${this.port}/?token=${encodeURIComponent(this.token)}`;
        const qrSvg = generateQrSvg(url);
        res.writeHead(200, { 'Content-Type': 'image/svg+xml', 'Access-Control-Allow-Origin': '*' });
        res.end(qrSvg);
        return;
      }

      if (pathname === '/api/screenshot') {
        try {
          const imgBase64 = await this.tabHost.captureScreenshot();
          const imgBuf = Buffer.from(imgBase64, 'base64');
          res.writeHead(200, { 'Content-Type': 'image/png', 'Access-Control-Allow-Origin': '*' });
          res.end(imgBuf);
        } catch {
          res.writeHead(500);
          res.end('Failed to capture screenshot');
        }
        return;
      }

      if (pathname === '/' || pathname === '/mobile' || pathname === '/remote') {
        const html = renderMobileRemoteHtml(this.token, this.port);
        res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
        res.end(html);
        return;
      }

      res.writeHead(404);
      res.end('Not Found');
    };
  }

  public async start(): Promise<number> {
    return new Promise<number>((resolve, reject) => {
      const handler = this.createHttpHandler();
      this.httpServer = http.createServer(handler);

      this.wss = new WebSocketServer({ server: this.httpServer });
      this.setupWssEvents();

      this.httpServer.on('error', (err: NodeJS.ErrnoException) => {
        if (err.code === 'EADDRINUSE') {
          console.log(`[antifan] Port ${this.port} is busy. Retrying with port 0...`);
          try {
            this.wss?.close();
          } catch {}
          const altServer = http.createServer(this.createHttpHandler());
          this.httpServer = altServer;
          this.wss = new WebSocketServer({ server: altServer });
          this.setupWssEvents();

          altServer.listen(0, '0.0.0.0', () => {
            const addr = altServer.address();
            if (addr && typeof addr === 'object') {
              this.port = addr.port;
            }
            this.persistBridgeInfo();
            resolve(this.port);
          });
        } else {
          reject(err);
        }
      });

      this.httpServer.listen(this.port, '0.0.0.0', () => {
        const address = this.httpServer?.address();
        if (address && typeof address === 'object') {
          this.port = address.port;
        }
        this.persistBridgeInfo();
        resolve(this.port);
      });
    });
  }

  public getToken(): string {
    return this.token;
  }

  public getPort(): number {
    return this.port;
  }

  private setupWssEvents(): void {
    if (!this.wss) return;

    this.wss.on('connection', (ws: WebSocket, req) => {
      // 1. Token authentication: must be provided and must match exactly
      const host = req.headers.host || `127.0.0.1:${this.port}`;
      const url = new URL(req.url || '/', `http://${host}`);
      const clientToken = url.searchParams.get('token');

      if (!clientToken || clientToken !== this.token) {
        ws.close(4001, 'Unauthorized: missing or invalid token');
        return;
      }

      // 2. Origin check: prevent arbitrary cross-origin hijacking
      const origin = req.headers.origin;
      if (origin) {
        try {
          const originUrl = new URL(origin);
          const [hostName] = host.split(':');
          const isAllowedOrigin =
            originUrl.hostname === 'localhost' ||
            originUrl.hostname === '127.0.0.1' ||
            originUrl.hostname === hostName ||
            getLocalLanIps().includes(originUrl.hostname);

          if (!isAllowedOrigin) {
            ws.close(4003, 'Forbidden: untrusted origin');
            return;
          }
        } catch {
          ws.close(4003, 'Forbidden: malformed origin header');
          return;
        }
      }

      this.clients.add(ws);

      const tm = TerminalManager.getInstance();
      this.sendEvent(ws, 'antifan:init', {
        status: this.getStatus(),
        tabs: this.tabHost.getTabList(),
        activeTabId: this.tabHost.getActiveTabId(),
        terminalSessions: tm.listSessions(),
        activeTerminalSessionId: tm.getActiveSessionId(),
      });

      ws.on('message', async (data) => {
        try {
          const str = data.toString();
          if (str.length > 5 * 1024 * 1024) {
            ws.send(JSON.stringify({ id: 'unknown', success: false, error: 'Payload exceeds 5MB limit' }));
            return;
          }
          const raw = JSON.parse(str) as BridgeRequestPayload;
          await this.handleMessage(ws, raw);
        } catch (err: unknown) {
          const errorMsg = err instanceof Error ? err.message : String(err);
          ws.send(JSON.stringify({ id: 'unknown', success: false, error: `Invalid JSON payload: ${errorMsg}` }));
        }
      });

      ws.on('close', () => {
        this.clients.delete(ws);
      });

      ws.on('error', () => {
        this.clients.delete(ws);
      });
    });
  }

  private persistBridgeInfo(): void {
    const info = {
      port: this.port,
      token: this.token,
      pid: process.pid,
      startedAt: Date.now(),
      isDev: this.isDev,
    };
    try {
      fs.writeFileSync(this.bridgeInfoPath, JSON.stringify(info, null, 2), 'utf8');

      const geminiDir = path.join(os.homedir(), '.gemini');
      if (fs.existsSync(geminiDir)) {
        const geminiFileName = this.isDev ? 'antifan_bridge_dev.json' : 'antifan_bridge.json';
        fs.writeFileSync(path.join(geminiDir, geminiFileName), JSON.stringify(info, null, 2), 'utf8');
      }
    } catch {}
  }

  private wireTabHostEvents(): void {
    this.tabHost.on('element-picked', (element: AntiFanPickedElement) => {
      this.broadcastEvent('antifan:elementPicked', element);
    });

    this.tabHost.on('tabs-changed', (tabs: AntiFanTab[], activeTabId: string) => {
      this.broadcastEvent('antifan:tabChanged', { tabs, activeTabId });
    });

    this.tabHost.on('inspect-toggled', (active: boolean) => {
      this.broadcastEvent('antifan:inspectStateChanged', { active });
    });

    this.tabHost.on('chat-prompt-submitted', (payload: { prompt: string; sessionId?: string; attachedElement?: AntiFanPickedElement; attachedImages?: Array<{ name: string; dataUrl: string }>; deliveryMode?: 'auto' | 'draft' }) => {
      this.broadcastEvent('antifan:chatPromptSubmitted', payload);
    });

    // Wire live terminal streaming and session lifecycle to WebSocket clients
    const tm = TerminalManager.getInstance();
    tm.on('data', (payload: { sessionId: string; data: string } | string) => {
      const formatted = typeof payload === 'string' ? { sessionId: tm.getActiveSessionId(), data: payload } : payload;
      this.broadcastEvent('antifan:terminal:data', formatted);
    });

    tm.on('session', (payload: unknown) => {
      this.broadcastEvent('antifan:terminal:session', payload);
    });
  }

  private async handleMessage(ws: WebSocket, payload: BridgeRequestPayload): Promise<void> {
    const { id, method, params } = payload;
    const p = (params || {}) as Record<string, any>;

    const respond = (success: boolean, data?: unknown, error?: string) => {
      const resp: BridgeResponsePayload = { id, success, data, error };
      if (ws.readyState === WebSocket.OPEN) {
        ws.send(JSON.stringify(resp));
      }
    };

    try {
      if (this.capabilityTransport && typeof p.runtimeLease === 'object' && typeof p.projectId === 'string' && typeof p.workspaceId === 'string') {
        const context = p.context as Partial<CapabilityRequestContext> | undefined;
        const requestedGrant = context?.grant;
        const bridgeGrant = requestedGrant === 'write' ? 'write' : 'read';
        const result = await this.capabilityTransport.dispatch(method, p, {
          lease: p.runtimeLease,
          leaseToken: typeof p.leaseToken === 'string' ? p.leaseToken : '',
          projectId: p.projectId,
          workspaceId: p.workspaceId,
          runId: context?.runId,
          attemptId: context?.attemptId,
          browserTarget: context?.browserTarget,
          grant: bridgeGrant,
        });
        respond(result.ok, result.data, result.error ? `${result.error.code}: ${result.error.message}` : undefined);
        return;
      }

      switch (method) {
        case 'agentMove':
        case 'antifan.agentMove': {
          const ok = await this.tabHost.agentMove({ selector: p.selector, x: p.x, y: p.y, label: p.label, tabId: p.tabId });
          respond(ok, { moved: ok });
          break;
        }
        case 'agentTrajectory':
        case 'antifan.agentTrajectory': {
          const result = await this.tabHost.agentTrajectory({
            steps: p.steps,
            speed: p.speed,
            smoothScroll: p.smoothScroll,
            tabId: p.tabId,
          });
          respond(Boolean(result.success), result);
          break;
        }


        case 'getRuntimeBinding':
        case 'antifan.getRuntimeBinding': {
          if (!this.runtimeBindingProvider) {
            respond(false, undefined, 'Runtime binding is unavailable');
            break;
          }
          respond(true, this.runtimeBindingProvider());
          break;
        }

        case 'openTab':
        case 'antifan.openTab': {
          const tabId = this.tabHost.createTab(p.url);
          respond(true, { tabId });
          break;
        }

        case 'switchTab':
        case 'antifan.switchTab': {
          const ok = this.tabHost.switchTab(p.tabId);
          respond(ok, { switched: ok });
          break;
        }

        case 'closeTab':
        case 'antifan.closeTab': {
          const ok = this.tabHost.closeTab(p.tabId);
          respond(ok, { closed: ok });
          break;
        }

        case 'navigate':
        case 'antifan.navigate': {
          const ok = this.tabHost.navigate(p.tabId || this.tabHost.getActiveTabId(), p.url);
          respond(ok, { navigated: ok });
          break;
        }

        case 'reload':
        case 'antifan.reload': {
          const ok = this.tabHost.reload(p.tabId || this.tabHost.getActiveTabId());
          respond(ok, { reloaded: ok });
          break;
        }

        case 'goBack':
        case 'antifan.goBack': {
          const ok = this.tabHost.goBack(p.tabId || this.tabHost.getActiveTabId());
          respond(ok, { wentBack: ok });
          break;
        }

        case 'goForward':
        case 'antifan.goForward': {
          const ok = this.tabHost.goForward(p.tabId || this.tabHost.getActiveTabId());
          respond(ok, { wentForward: ok });
          break;
        }

        case 'toggleInspect':
        case 'antifan.toggleInspect': {
          const inspecting = this.tabHost.toggleInspect();
          respond(true, { inspecting });
          break;
        }

        case 'toggleRuler':
        case 'antifan.toggleRuler': {
          const active = this.tabHost.toggleRuler();
          respond(true, { active });
          break;
        }

        case 'toggleFontFinder':
        case 'antifan.toggleFontFinder': {
          const active = this.tabHost.toggleFontFinder();
          respond(true, { active });
          break;
        }

        case 'toggleSidebar':
        case 'antifan.toggleSidebar': {
          const isOpen = this.tabHost.toggleSidebar();
          respond(true, { isOpen });
          break;
        }

        case 'pushAgentMessage':
        case 'antifan.pushAgentMessage': {
          if (p.message) {
            this.tabHost.pushAgentMessage(p.message as ChatMessage);
            respond(true, { pushed: true });
          } else {
            respond(false, undefined, 'Missing message in payload');
          }
          break;
        }

        case 'terminalInput':
        case 'antifan.terminalInput': {
          if (typeof p.text === 'string') {
            const tm = TerminalManager.getInstance();
            if (p.sessionId) {
              tm.writeTo(p.sessionId, p.text);
            } else {
              tm.write(p.text);
            }
            respond(true, { written: true });
          } else {
            respond(false, undefined, 'Missing text in terminalInput');
          }
          break;
        }

        case 'terminalSendKey':
        case 'antifan.terminalSendKey': {
          const keyMap: Record<string, string> = {
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
          const key = typeof p.key === 'string' ? p.key.toLowerCase() : '';
          const sequence = keyMap[key] ?? p.sequence;
          if (typeof sequence === 'string') {
            const tm = TerminalManager.getInstance();
            if (p.sessionId) {
              tm.writeTo(p.sessionId, sequence);
            } else {
              tm.write(sequence);
            }
            respond(true, { sent: true, key });
          } else {
            respond(false, undefined, `Unknown key: ${p.key}`);
          }
          break;
        }

        case 'terminalListSessions':
        case 'antifan.terminalListSessions':
        case 'getTerminalSessions':
        case 'antifan.getTerminalSessions': {
          const tm = TerminalManager.getInstance();
          respond(true, {
            sessions: tm.listSessions(),
            activeSessionId: tm.getActiveSessionId(),
          });
          break;
        }

        case 'terminalSwitchSession':
        case 'antifan.terminalSwitchSession': {
          if (typeof p.sessionId === 'string') {
            const tm = TerminalManager.getInstance();
            const switched = tm.switchSession(p.sessionId);
            respond(switched, { switched, activeSessionId: tm.getActiveSessionId() });
          } else {
            respond(false, undefined, 'Missing sessionId');
          }
          break;
        }

        case 'terminalNewSession':
        case 'antifan.terminalNewSession': {
          const tm = TerminalManager.getInstance();
          const sessionId = tm.createSession(p.cwd);
          respond(true, { sessionId, sessions: tm.listSessions() });
          break;
        }

        case 'terminalCloseSession':
        case 'antifan.terminalCloseSession': {
          const tm = TerminalManager.getInstance();
          const targetId = p.sessionId || tm.getActiveSessionId();
          const closed = await tm.closeSession(targetId);
          respond(closed, { closed, sessions: tm.listSessions(), activeSessionId: tm.getActiveSessionId() });
          break;
        }

        case 'terminalRenameSession':
        case 'antifan.terminalRenameSession': {
          const tm = TerminalManager.getInstance();
          const targetId = p.id || p.sessionId || tm.getActiveSessionId();
          const renamed = tm.renameSession(targetId, p.name || '');
          respond(renamed, { renamed, sessions: tm.listSessions() });
          break;
        }
        case 'terminalRestart':
        case 'antifan.terminalRestart': {
          const tm = TerminalManager.getInstance();
          await tm.restart(p.cwd);
          respond(true, { restarted: true });
          break;
        }

        case 'terminalResize':
        case 'antifan.terminalResize': {
          const tm = TerminalManager.getInstance();
          const cols = Number(p.cols) || 80;
          const rows = Number(p.rows) || 24;
          if (p.sessionId) {
            tm.resizeTo(p.sessionId, cols, rows);
          } else {
            tm.resize(cols, rows);
          }
          respond(true, { resized: true, cols, rows });
          break;
        }

        case 'getTabs':
        case 'antifan.getTabs': {
          respond(true, { tabs: this.tabHost.getTabList(), activeTabId: this.tabHost.getActiveTabId() });
          break;
        }

        case 'getDOM':
        case 'antifan.getDOM': {
          const dom = await this.tabHost.getDom(p.selector);
          respond(true, { html: dom });
          break;
        }

        case 'captureScreenshot':
        case 'antifan.captureScreenshot': {
          const imageBase64 = await this.tabHost.captureScreenshot();
          respond(true, { imageBase64 });
          break;
        }

        case 'evalJS':
        case 'antifan.evalJS': {
          const result = await this.tabHost.evalJs(p.expression);
          respond(true, { result });
          break;
        }

        case 'getStatus':
        case 'antifan.getStatus': {
          respond(true, this.getStatus());
          break;
        }

        case 'getLanIps':
        case 'antifan.getLanIps': {
          const lanIps = getLocalLanIps();
          const urls = lanIps.map(ip => `http://${ip}:${this.port}/?token=${encodeURIComponent(this.token)}`);
          const primaryUrl = urls[0] || `http://localhost:${this.port}/?token=${encodeURIComponent(this.token)}`;
          const qrSvg = generateQrSvg(primaryUrl);
          respond(true, { port: this.port, token: this.token, lanIps, urls, primaryUrl, qrSvg });
          break;
        }

        // ─── Agent Browser Automation & Visual Cursor ───
        case 'agentClick':
        case 'antifan.agentClick': {
          const ok = await this.tabHost.agentClick({
            selector: p.selector,
            x: p.x,
            y: p.y,
            label: p.label,
            tabId: p.tabId,
          });
          respond(ok, { clicked: ok });
          break;
        }

        case 'agentType':
        case 'antifan.agentType': {
          const ok = await this.tabHost.agentType({
            selector: p.selector,
            text: p.text,
            clear: p.clear,
            tabId: p.tabId,
          });
          respond(ok, { typed: ok });
          break;
        }

        case 'agentScroll':
        case 'antifan.agentScroll': {
          const ok = await this.tabHost.agentScroll({
            deltaY: p.deltaY,
            selector: p.selector,
            tabId: p.tabId,
          });
          respond(ok, { scrolled: ok });
          break;
        }

        case 'agentHover':
        case 'antifan.agentHover': {
          const ok = await this.tabHost.agentHover({
            selector: p.selector,
            x: p.x,
            y: p.y,
            label: p.label,
            tabId: p.tabId,
          });
          respond(ok, { hovered: ok });
          break;
        }

        case 'agentHighlight':
        case 'antifan.agentHighlight': {
          const ok = await this.tabHost.agentHighlight({
            selector: p.selector,
            label: p.label,
            tabId: p.tabId,
          });
          respond(ok, { highlighted: ok });
          break;
        }

        case 'agentClear':
        case 'antifan.agentClear': {
          const ok = await this.tabHost.agentClear(p.tabId);
          respond(ok, { cleared: ok });
          break;
        }

        default:
          respond(false, undefined, `Unknown bridge method: ${method}`);
      }
    } catch (err: unknown) {
      const errorMsg = err instanceof Error ? err.message : String(err);
      respond(false, undefined, errorMsg);
    }
  }

  private sendEvent(ws: WebSocket, event: string, data: unknown): void {
    if (ws.readyState === WebSocket.OPEN) {
      const payload: BridgeEventPayload = { event, data };
      ws.send(JSON.stringify(payload));
    }
  }

  public broadcastEvent(event: string, data: unknown): void {
    const payload: BridgeEventPayload = { event, data };
    const raw = JSON.stringify(payload);
    for (const client of this.clients) {
      if (client.readyState === WebSocket.OPEN) {
        client.send(raw);
      }
    }
  }

  public getStatus(): AntiFanBridgeStatus {
    return {
      active: true,
      port: this.port,
      clientCount: this.clients.size,
      activeTabId: this.tabHost.getActiveTabId(),
      tabCount: this.tabHost.getTabList().length,
      inspecting: false,
    };
  }

  public dispose(): void {
    try {
      if (fs.existsSync(this.bridgeInfoPath)) {
        fs.unlinkSync(this.bridgeInfoPath);
      }
    } catch {}

    for (const client of this.clients) {
      client.close();
    }
    this.clients.clear();
    this.wss?.close();
    this.httpServer?.close();
  }
}
