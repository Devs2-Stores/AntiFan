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
import { BrowserActionRegistry } from '../browser/browser-action-registry';
import {
  AntiFanBridgeStatus,
  BridgeRequestPayload,
  BridgeResponsePayload,
  BridgeEventPayload,
  AntiFanPickedElement,
  AntiFanTab,
} from '../../shared/contracts';

export class BridgeServer {
  private wss: WebSocketServer | null = null;
  private httpServer: http.Server | null = null;
  private clients: Set<WebSocket> = new Set();
  private tabHost: NativeTabHost;
  private registry: BrowserActionRegistry;
  private port: number = 20129;
  private token: string = randomUUID();
  private bridgeInfoPath: string;

  constructor(tabHost: NativeTabHost, port = 20129, registry?: BrowserActionRegistry) {
    this.tabHost = tabHost;
    this.registry = registry || new BrowserActionRegistry(tabHost);
    this.port = port;

    const configDir = path.join(os.homedir(), '.antifan');
    if (!fs.existsSync(configDir)) {
      try {
        fs.mkdirSync(configDir, { recursive: true });
      } catch {}
    }
    this.bridgeInfoPath = path.join(configDir, 'bridge.json');

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
    };
    try {
      fs.writeFileSync(this.bridgeInfoPath, JSON.stringify(info, null, 2), 'utf8');

      const geminiDir = path.join(os.homedir(), '.gemini');
      if (fs.existsSync(geminiDir)) {
        fs.writeFileSync(path.join(geminiDir, 'antifan_bridge.json'), JSON.stringify(info, null, 2), 'utf8');
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

    this.tabHost.on('chat-prompt-submitted', (payload: { prompt: string; attachedElement?: AntiFanPickedElement; attachedImages?: Array<{ name: string; dataUrl: string }>; deliveryMode?: 'auto' | 'draft' }) => {
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
      if (method === 'getStatus' || method === 'antifan.getStatus') {
        respond(true, this.getStatus());
        return;
      }

      const data = await this.registry.execute(method, p, true);
      respond(true, data);
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
