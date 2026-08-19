/**
 * AntiFan Browser Desktop — Bridge Server (Extension & IDE Companion)
 * Fast, authenticated local WebSocket RPC server bridging between IDE Extension / Agent and Chromium Desktop.
 */
import { WebSocketServer, WebSocket } from 'ws';
import * as http from 'node:http';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import { randomUUID } from 'node:crypto';
import { NativeTabHost } from '../browser/native-tab-host';
import {
  AntiFanBridgeStatus,
  BridgeRequestPayload,
  BridgeResponsePayload,
  BridgeEventPayload,
  AntiFanPickedElement,
  AntiFanTab,
  ChatMessage,
} from '../../shared/contracts';

export class BridgeServer {
  private wss: WebSocketServer | null = null;
  private httpServer: http.Server | null = null;
  private clients: Set<WebSocket> = new Set();
  private tabHost: NativeTabHost;
  private isDev: boolean = false;
  private port: number = 20129;
  private token: string = randomUUID();
  private bridgeInfoPath: string;

  constructor(tabHost: NativeTabHost, port = 20129, isDev = false) {
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

    this.wireTabHostEvents();
  }

  public async start(): Promise<number> {
    return new Promise((resolve, reject) => {
      this.httpServer = http.createServer((req, res) => {
        if (req.url === '/status') {
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify(this.getStatus()));
          return;
        }
        res.writeHead(404);
        res.end();
      });

      this.wss = new WebSocketServer({ server: this.httpServer });
      this.setupWssEvents();

      this.httpServer.on('error', (err: NodeJS.ErrnoException) => {
        if (err.code === 'EADDRINUSE') {
          console.log(`[antifan] Port ${this.port} is busy. Retrying with port 0...`);
          try {
            this.wss?.close();
          } catch {}
          const altServer = http.createServer((req, res) => {
            if (req.url === '/status') {
              res.writeHead(200, { 'Content-Type': 'application/json' });
              res.end(JSON.stringify(this.getStatus()));
              return;
            }
            res.writeHead(404);
            res.end();
          });
          this.httpServer = altServer;
          this.wss = new WebSocketServer({ server: altServer });
          this.setupWssEvents();

          altServer.listen(0, '127.0.0.1', () => {
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

      this.httpServer.listen(this.port, '127.0.0.1', () => {
        const address = this.httpServer?.address();
        if (address && typeof address === 'object') {
          this.port = address.port;
        }
        this.persistBridgeInfo();
        resolve(this.port);
      });
    });
  }

  private setupWssEvents(): void {
    if (!this.wss) return;

    this.wss.on('connection', (ws: WebSocket, req) => {
      const url = new URL(req.url || '/', `http://${req.headers.host || '127.0.0.1'}`);
      const clientToken = url.searchParams.get('token');

      if (clientToken && clientToken !== this.token) {
        ws.close(4001, 'Unauthorized token');
        return;
      }

      this.clients.add(ws);

      this.sendEvent(ws, 'antifan:init', {
        status: this.getStatus(),
        tabs: this.tabHost.getTabList(),
        activeTabId: this.tabHost.getActiveTabId(),
      });

      ws.on('message', async (data) => {
        try {
          const raw = JSON.parse(data.toString()) as BridgeRequestPayload;
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
      switch (method) {
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
