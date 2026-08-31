/**
 * AntiFan Browser Desktop — Bridge Server (Extension & IDE Companion)
 * Fast, authenticated local WebSocket RPC server bridging between IDE Extension / Agent and Chromium Desktop.
 * Includes Mobile Remote Companion Web App, Live Viewport streaming, and Terminal RPC.
 */
import { app, session } from 'electron';
import { cookieImportSetDetails, extensionCookieImportSetDetails, ExtensionCookieInput } from '../browser/chrome-profile-sync';
import { deriveCapsulePartition } from '../browser/browser-session-partition';
import { WebSocketServer, WebSocket } from 'ws';
import * as http from 'node:http';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import { StorageLocations } from '../config/storage-locations';
import { randomUUID } from 'node:crypto';
import { performance } from 'node:perf_hooks';
import { isBenchmarkEnabled, recordBenchmark } from '../benchmark/telemetry';
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
} from '../../shared/contracts';
import { CapabilityTransportAdapter } from '../tools/capability-transport';
import { CapabilityRequestContext, CapabilityError, BrowserTarget, RuntimeLease } from '../../shared/control-plane-contracts';
import { AttachmentRegistry } from '../run/attachment-registry';
import { ControlPlaneRuntime } from '../control-plane/control-plane-runtime';
// Slow-client bounds. A WebSocket whose kernel backlog exceeds the soft high-water
// mark routes events through a per-client FIFO (consecutive terminal-data frames
// coalesce losslessly: same bytes, same order) instead of unbounded ws.send buffering.
// The heartbeat interval detects dead peers so they cannot accumulate in `clients`.
const BRIDGE_SOFT_HIGH_WATER = 8 * 1024 * 1024; // bytes buffered per client before coalescing engages
const BRIDGE_QUEUE_HARD_CAP = 32 * 1024 * 1024; // per-client FIFO cap; a client that cannot drain past it is terminated
const BRIDGE_DRAIN_INTERVAL_MS = 50; // congestion pump cadence
const BRIDGE_HEARTBEAT_INTERVAL_MS = 30_000; // ping cadence; peers silent for two ticks are terminated

interface PendingOutboundFrame {
  raw: string;
  /** serialized frame byte size this entry contributes to queuedBytes */
  bytes: number;
  /** non-null => terminal:data frame; consecutive frames for the same session merge */
  coalesceKey: string | null;
  sessionId?: string;
  data?: string;
  seq?: number;
}

interface BridgeCongestionState {
  queue: PendingOutboundFrame[];
  queuedBytes: number;
}

type HeartbeatWebSocket = WebSocket & { isAlive?: boolean };

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
  private readonly socketAttachmentIds: WeakMap<WebSocket, string> = new WeakMap();
  private tabHost: NativeTabHost;
  private isDev: boolean = false;
  private port: number = 20129;
  private host: string = '127.0.0.1';
  private token: string = randomUUID();
  private bridgeInfoPath: string;
  private readonly capabilityTransport?: CapabilityTransportAdapter;
  private readonly runtimeBindingProvider?: () => RuntimeBinding;
  private readonly attachmentRegistry?: AttachmentRegistry;
  private controlPlaneRuntime?: ControlPlaneRuntime;
  private readonly clientCongestion: WeakMap<WebSocket, BridgeCongestionState> = new WeakMap();
  private drainTimer: NodeJS.Timeout | null = null;
  private heartbeatTimer: NodeJS.Timeout | null = null;

  constructor(
    tabHost: NativeTabHost,
    port = 20129,
    isDev = false,
    capabilityTransport?: CapabilityTransportAdapter,
    runtimeBindingProvider?: () => RuntimeBinding,
    attachmentRegistry?: AttachmentRegistry,
    host = '127.0.0.1',
    controlPlaneRuntime?: ControlPlaneRuntime
  ) {
    this.tabHost = tabHost;
    this.isDev = isDev;
    this.port = isDev && port === 20129 ? 20130 : port;

    const configDir = process.env.ANTIFAN_CONFIG_DIR || StorageLocations.getConfigDir();
    if (!fs.existsSync(configDir)) {
      try {
        fs.mkdirSync(configDir, { recursive: true });
      } catch {}
    }
    const bridgeFileName = this.isDev ? 'bridge-dev.json' : 'bridge.json';
    this.bridgeInfoPath = path.join(configDir, bridgeFileName);
    this.capabilityTransport = capabilityTransport;
    this.runtimeBindingProvider = runtimeBindingProvider;
    this.attachmentRegistry = attachmentRegistry;
    this.host = host || '127.0.0.1';
    this.controlPlaneRuntime = controlPlaneRuntime;
    BridgeServer.instance = this;
    this.wireTabHostEvents();
  }

  public getHost(): string {
    return this.host;
  }

  public static getInstance(): BridgeServer | null {
    return BridgeServer.instance;
  }
  public setControlPlane(controlPlane: ControlPlaneRuntime): void {
    this.controlPlaneRuntime = controlPlane;
  }
  public rotateToken(): string {
    this.token = randomUUID();
    this.persistBridgeInfo();

    // Terminate existing master-token WebSocket connections while preserving attachment-scoped clients
    for (const client of Array.from(this.clients)) {
      if (!this.socketAttachmentIds.has(client)) {
        try {
          client.close(4001, 'Bridge token rotated: connection invalidated');
        } catch {}
        this.clients.delete(client);
      }
    }

    return this.token;
  }

  public getRemoteConnectionInfo(): { port: number; lanIps: string[]; urls: string[]; primaryUrl: string; qrSvg: string } {
    const lanIps = getLocalLanIps();
    const urls = lanIps.map(ip => `http://${ip}:${this.port}/`);
    const primaryUrl = urls[0] || `http://localhost:${this.port}/`;
    const qrSvg = generateQrSvg(primaryUrl);
    return { port: this.port, lanIps, urls, primaryUrl, qrSvg };
  }

  private createHttpHandler(): (req: http.IncomingMessage, res: http.ServerResponse) => void {
    return async (req, res) => {
      const host = req.headers.host || `127.0.0.1:${this.port}`;
      const reqUrl = new URL(req.url || '/', `http://${host}`);
      const pathname = reqUrl.pathname;
      const clientToken = extractAuthToken(req, reqUrl);
      const isBridgeToken = Boolean(clientToken && clientToken === this.token);
      const verifiedAttachmentId = clientToken ? (this.attachmentRegistry?.verifyConnectionToken(clientToken) ?? null) : null;

      const rawOrigin = typeof req.headers.origin === 'string' ? req.headers.origin : '';
      const isAllowedOrigin = rawOrigin.startsWith('chrome-extension://') ||
                              rawOrigin.startsWith('http://localhost') ||
                              rawOrigin.startsWith('http://127.0.0.1');

      if (req.method === 'OPTIONS') {
        const preflightHeaders: Record<string, string> = {
          'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
          'Access-Control-Allow-Headers': 'Content-Type, Authorization, x-antifan-attachment-secret',
        };
        if (isAllowedOrigin) {
          preflightHeaders['Access-Control-Allow-Origin'] = rawOrigin;
        }
        res.writeHead(204, preflightHeaders);
        res.end();
        return;
      }

      if (pathname === '/api/screenshot' || pathname === '/api/remote-info' || pathname === '/api/qr' || pathname === '/api/cookies/import') {
        if (!isBridgeToken && !verifiedAttachmentId) {
          const unauthHeaders: Record<string, string> = { 'Content-Type': 'application/json' };
          if (isAllowedOrigin) unauthHeaders['Access-Control-Allow-Origin'] = rawOrigin;
          res.writeHead(401, unauthHeaders);
          res.end(JSON.stringify({ error: 'Unauthorized: missing or invalid token' }));
          return;
        }
      }
      if (pathname === '/status') {
        res.writeHead(200, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' });
        res.end(JSON.stringify(this.getStatus()));
        return;
      }

      if (pathname === '/api/lan-ips' || pathname === '/api/remote-info') {
        res.writeHead(200, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' });
        res.end(JSON.stringify(this.getRemoteConnectionInfo()));
        return;
      }

      if (pathname === '/api/qr') {
        const info = this.getRemoteConnectionInfo();
        res.writeHead(200, { 'Content-Type': 'image/svg+xml', 'Access-Control-Allow-Origin': '*' });
        res.end(info.qrSvg);
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
      if (pathname === '/api/cookies/import' && req.method === 'POST') {
        let body = '';
        let size = 0;
        const MAX_BODY_SIZE = 10 * 1024 * 1024; // 10MB
        let isTooLarge = false;

        req.on('data', (chunk) => {
          size += chunk.length;
          if (size > MAX_BODY_SIZE) {
            isTooLarge = true;
            res.writeHead(413, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ success: false, error: 'Payload Too Large (max 10MB)' }));
            req.destroy();
            return;
          }
          body += chunk;
        });

        req.on('end', async () => {
          if (isTooLarge) return;
          const responseHeaders: Record<string, string> = { 'Content-Type': 'application/json' };
          if (isAllowedOrigin) responseHeaders['Access-Control-Allow-Origin'] = rawOrigin;

          try {
            const data = JSON.parse(body || '{}');
            const rawCookies: ExtensionCookieInput[] = Array.isArray(data.cookies)
              ? data.cookies
              : (Array.isArray(data.upserted) ? data.upserted : []);
            const rawRemoved: Array<{ name: string; domain?: string; host?: string; path?: string; secure?: boolean }> =
              Array.isArray(data.removed) ? data.removed : [];

            const requestedPartition = typeof data.partition === 'string' && data.partition.trim()
              ? data.partition.trim()
              : (typeof data.targetPartition === 'string' && data.targetPartition.trim()
                ? data.targetPartition.trim()
                : (typeof data.targetCapsuleId === 'string' && data.targetCapsuleId.trim()
                  ? deriveCapsulePartition(data.targetCapsuleId.trim())
                  : (typeof data.capsuleId === 'string' && data.capsuleId.trim()
                    ? deriveCapsulePartition(data.capsuleId.trim())
                    : null)));
            let targetSession: Electron.Session;
            if (verifiedAttachmentId && !isBridgeToken) {
              // Attachment token: enforce attachment-scoped boundary
              if (requestedPartition) {
                res.writeHead(403, responseHeaders);
                res.end(JSON.stringify({ success: false, error: 'Forbidden: attachment tokens cannot target arbitrary partitions' }));
                return;
              }
              const boundTabId = this.attachmentRegistry?.getRecord(verifiedAttachmentId)?.tabId;
              if (typeof data.tabId === 'string' && data.tabId.trim() && boundTabId && data.tabId.trim() !== boundTabId) {
                res.writeHead(403, responseHeaders);
                res.end(JSON.stringify({ success: false, error: `Forbidden: attachment token bound to tab "${boundTabId}", cannot target "${data.tabId}"` }));
                return;
              }
              const targetTabId = boundTabId || (typeof data.tabId === 'string' ? data.tabId.trim() : this.tabHost.getActiveTab()?.id);
              const tabSession = targetTabId ? this.tabHost.getTabSession(targetTabId) : null;
              if (!tabSession) {
                res.writeHead(400, responseHeaders);
                res.end(JSON.stringify({ success: false, error: `Target tab "${targetTabId || 'none'}" not found or destroyed` }));
                return;
              }
              targetSession = tabSession;
            } else {
              // Master bridge token: allow explicit tabId, partition, or default to active tab
              if (data.source === 'chrome-extension-delta' && !requestedPartition) {
                res.writeHead(400, responseHeaders);
                res.end(JSON.stringify({ success: false, error: 'MISSING_TARGET_PARTITION', message: 'Explicit targetPartition or targetCapsuleId is required for background delta sync.' }));
                return;
              }

              if (typeof data.tabId === 'string' && data.tabId.trim()) {
                const tabSession = this.tabHost.getTabSession(data.tabId.trim());
                if (!tabSession) {
                  res.writeHead(400, responseHeaders);
                  res.end(JSON.stringify({ success: false, error: `Target tabId "${data.tabId}" not found or destroyed` }));
                  return;
                }
                targetSession = tabSession;
              } else if (requestedPartition) {
                if (!this.tabHost.isValidCapsulePartition(requestedPartition)) {
                  res.writeHead(404, responseHeaders);
                  res.end(JSON.stringify({ success: false, error: 'UNKNOWN_TARGET_PARTITION', message: `Partition "${requestedPartition}" is not an active or registered capsule session.` }));
                  return;
                }
                targetSession = this.tabHost.getPartitionSession(requestedPartition);
              } else {
                targetSession = this.tabHost.getActiveTabSession();
              }
            }

            let importedCount = 0;
            let removedCount = 0;
            let skippedCount = 0;
            let failedCount = 0;

            // 1. Process Upserts
            for (const cookie of rawCookies) {
              const setDetails = extensionCookieImportSetDetails(cookie);
              if (!setDetails) {
                skippedCount++;
                continue;
              }

              try {
                await targetSession.cookies.set(setDetails);
                importedCount++;
              } catch {
                failedCount++;
              }
            }

            // 2. Process Delta Removals
            for (const rem of rawRemoved) {
              if (!rem || !rem.name) continue;
              const host = rem.domain || rem.host || '';
              if (!host) {
                skippedCount++;
                continue;
              }
              const secure = Boolean(rem.secure);
              const scheme = secure ? 'https://' : 'http://';
              const domain = host.startsWith('.') ? host.substring(1) : host;
              const cookiePath = rem.path || '/';
              const cookieUrl = `${scheme}${domain}${cookiePath}`;
              try {
                await targetSession.cookies.remove(cookieUrl, rem.name);
                removedCount++;
              } catch {
                failedCount++;
              }
            }

            try {
              await targetSession.cookies.flushStore();
            } catch {}

            res.writeHead(200, responseHeaders);
            res.end(JSON.stringify({
              success: true,
              importedCount,
              removedCount,
              skippedCount,
              failedCount,
              totalReceived: rawCookies.length + rawRemoved.length,
              targetTabId: data.tabId || this.tabHost.getActiveTab()?.id || null,
              targetPartition: requestedPartition || 'activeTab',
            }));
          } catch (err: unknown) {
            res.writeHead(400, responseHeaders);
            res.end(JSON.stringify({ success: false, error: err instanceof Error ? err.message : String(err) }));
          }
        });
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
          try {
            this.httpServer?.removeAllListeners('error');
            this.httpServer?.close();
          } catch {}
          const altServer = http.createServer(this.createHttpHandler());
          altServer.on('error', (altErr) => reject(altErr));
          this.httpServer = altServer;
          this.wss = new WebSocketServer({ server: altServer });
          this.setupWssEvents();

          altServer.listen(0, this.host, () => {
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

      this.httpServer.listen(this.port, this.host, () => {
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
      // 1. Token authentication: query param, Authorization: Bearer, or X-Antifan-Attachment-Secret
      const host = req.headers.host || `127.0.0.1:${this.port}`;
      const url = new URL(req.url || '/', `http://${host}`);
      const clientToken = extractAuthToken(req, url);
      const isBridgeToken = Boolean(clientToken && clientToken === this.token);
      const verifiedAttachmentId = clientToken ? (this.attachmentRegistry?.verifyConnectionToken(clientToken) ?? null) : null;
      if (!isBridgeToken && !verifiedAttachmentId) {
        ws.close(4001, 'Unauthorized: missing or invalid token');
        return;
      }

      if (verifiedAttachmentId && !isBridgeToken) {
        this.socketAttachmentIds.set(ws, verifiedAttachmentId);
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

      const hbClient = ws as HeartbeatWebSocket;
      hbClient.isAlive = true;
      ws.on('pong', () => {
        (ws as HeartbeatWebSocket).isAlive = true;
      });
      this.ensureHeartbeat();

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
      host: this.host,
      pid: process.pid,
      startedAt: Date.now(),
      isDev: this.isDev,
      token: this.token,
    };
    try {
      fs.writeFileSync(this.bridgeInfoPath, JSON.stringify(info, null, 2), { encoding: 'utf8', mode: 0o600 });

      const geminiDir = path.join(os.homedir(), '.gemini');
      if (fs.existsSync(geminiDir)) {
        const geminiFileName = this.isDev ? 'antifan_bridge_dev.json' : 'antifan_bridge.json';
        fs.writeFileSync(path.join(geminiDir, geminiFileName), JSON.stringify(info, null, 2), { encoding: 'utf8', mode: 0o600 });
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
      const boundAttachmentId = this.socketAttachmentIds.get(ws);
      if (boundAttachmentId && method !== 'antifan.capability.dispatch') {
        respond(false, undefined, 'Forbidden: Attachment-authenticated connections may only invoke antifan.capability.dispatch');
        return;
      }
      if (method !== 'antifan.capability.dispatch' && this.capabilityTransport && typeof p.runtimeLease === 'object') {
        respond(false, undefined, 'UNAUTHENTICATED: Direct capability dispatch without attachment claims is forbidden. Use antifan.capability.dispatch.');
        return;
      }

      switch (method) {
        case 'antifan.capability.dispatch': {
          if (!this.capabilityTransport) {
            respond(false, undefined, 'Capability transport is not available');
            break;
          }
          if (!this.attachmentRegistry) {
            respond(false, undefined, 'Attachment registry is not available');
            break;
          }
          try {
            const claims = p.attachmentClaims;
            if (boundAttachmentId && claims?.attachmentId !== boundAttachmentId) {
              respond(false, undefined, 'ATTACHMENT_INVALID: Cross-attachment dispatch denied: connection is bound to a different attachment');
              break;
            }
            const authContext = this.attachmentRegistry.validateAttachment(claims);
            const explicitTabId = typeof p.params?.tabId === 'string' && p.params.tabId.trim().length > 0 ? p.params.tabId.trim() : undefined;
            const isTargetAgnostic =
              p.name === 'browser.set-automation-target' || p.name === 'antifan_set_automation_target' ||
              p.name === 'browser.open-tab' || p.name === 'antifan_open_tab' || p.name === 'anti.browser.tabs.create' ||
              p.name === 'browser.list-tabs' || p.name === 'antifan_list_tabs' || p.name === 'anti.browser.tabs.list' ||
              p.name === 'browser.switch-tab' || p.name === 'antifan_switch_tab' || p.name === 'anti.browser.tabs.activate' ||
              p.name === 'browser.close-tab' || p.name === 'antifan_close_tab' || p.name === 'anti.browser.tabs.close';

            const tabList = this.tabHost?.getTabList ? this.tabHost.getTabList() : [];
            const isTabAlive = (id?: string) => Boolean(id && Array.isArray(tabList) && tabList.some((t: unknown) => Boolean(t && typeof t === 'object' && 'id' in t && t.id === id)));
            if (explicitTabId && authContext.browserTarget?.tabId && explicitTabId !== authContext.browserTarget.tabId.trim() && !isTargetAgnostic) {
              if (isTabAlive(explicitTabId)) {
                const liveDocGen = this.tabHost?.getDocumentGeneration ? this.tabHost.getDocumentGeneration(explicitTabId) : 1;
                if (claims?.attachmentId) {
                  this.attachmentRegistry.updateAttachmentTab(claims.attachmentId, explicitTabId, liveDocGen);
                }
                if (this.tabHost?.setAutomationTabId) {
                  this.tabHost.setAutomationTabId(explicitTabId);
                }
                authContext.browserTarget.tabId = explicitTabId;
                authContext.browserTarget.documentGeneration = liveDocGen;
              } else {
                respond(false, undefined, `TARGET_MISMATCH: Explicit tabId '${explicitTabId}' does not match authenticated target tabId '${authContext.browserTarget.tabId}' and is not a valid live tab`);
                break;
              }
            }
            const dispatchResult = await this.capabilityTransport.dispatch(p.name, p.params || {}, authContext);
            if (dispatchResult.ok) {
              if (claims?.attachmentId && dispatchResult.data && typeof dispatchResult.data === 'object') {
                const dataObj = dispatchResult.data as Record<string, unknown>;
                const isSetAutomationTarget = p.name === 'browser.set-automation-target' || p.name === 'antifan_set_automation_target';
                const isOpenTab = p.name === 'browser.open-tab' || p.name === 'antifan_open_tab' || p.name === 'anti.browser.tabs.create';
                const isSwitchTab = p.name === 'browser.switch-tab' || p.name === 'antifan_switch_tab' || p.name === 'anti.browser.tabs.activate';
                const isNavigate = p.name === 'browser.navigate' || p.name === 'anti.browser.navigate' || p.name === 'antifan_navigate' || p.name === 'browser.reload' || p.name === 'antifan_reload' || p.name === 'anti.browser.reload';
                if (isSetAutomationTarget || isOpenTab) {
                  const newTabId = typeof dataObj.tabId === 'string' ? dataObj.tabId : undefined;
                  if (newTabId) {
                    const liveDocGen = this.tabHost?.getDocumentGeneration ? this.tabHost.getDocumentGeneration(newTabId) : 1;
                    if (this.tabHost.setAutomationTabId) {
                      this.tabHost.setAutomationTabId(newTabId);
                    }
                    this.attachmentRegistry.updateAttachmentTab(claims.attachmentId, newTabId, liveDocGen);
                    if (authContext.browserTarget) {
                      authContext.browserTarget.tabId = newTabId;
                      authContext.browserTarget.documentGeneration = liveDocGen;
                    }
                  }
                } else if (isSwitchTab) {
                  const switchedTabId = typeof p.params?.tabId === 'string' ? p.params.tabId.trim() : undefined;
                  if (switchedTabId && isTabAlive(switchedTabId)) {
                    const liveDocGen = this.tabHost?.getDocumentGeneration ? this.tabHost.getDocumentGeneration(switchedTabId) : 1;
                    if (this.tabHost.setAutomationTabId) {
                      this.tabHost.setAutomationTabId(switchedTabId);
                    }
                    this.attachmentRegistry.updateAttachmentTab(claims.attachmentId, switchedTabId, liveDocGen);
                    if (authContext.browserTarget) {
                      authContext.browserTarget.tabId = switchedTabId;
                      authContext.browserTarget.documentGeneration = liveDocGen;
                    }
                  }
                } else if (isNavigate) {
                  const navTarget = dataObj.target && typeof dataObj.target === 'object' ? dataObj.target as Record<string, unknown> : undefined;
                  const tabId = typeof navTarget?.tabId === 'string' ? navTarget.tabId : authContext.browserTarget?.tabId;
                  const docGen = typeof navTarget?.documentGeneration === 'number' ? navTarget.documentGeneration : (tabId && this.tabHost?.getDocumentGeneration ? this.tabHost.getDocumentGeneration(tabId) : undefined);
                  if (tabId) {
                    this.attachmentRegistry.updateAttachmentTab(claims.attachmentId, tabId, docGen);
                  }
                  if (authContext.browserTarget && typeof docGen === 'number') {
                    authContext.browserTarget.documentGeneration = docGen;
                  }
                }
              }
              respond(true, dispatchResult.data);
            } else {
              respond(false, undefined, dispatchResult.error ? `${dispatchResult.error.code}: ${dispatchResult.error.message}` : 'Capability dispatch failed');
            }
          } catch (err: unknown) {
            const errorMsg = err instanceof CapabilityError ? `${err.code}: ${err.message}` : (err instanceof Error ? err.message : String(err));
            respond(false, undefined, errorMsg);
          }
          break;
        }
        case 'antifan.cli.startSession': {
          if (!this.controlPlaneRuntime) {
            respond(false, undefined, 'Control plane runtime is not available');
            break;
          }
          try {
            let tabId = p.tabId;
            if (!tabId) {
              const currentAutoTab = this.tabHost.getAutomationTabId ? this.tabHost.getAutomationTabId() : undefined;
              if (currentAutoTab && this.tabHost.getTabList().some((tab: any) => tab && tab.id === currentAutoTab)) {
                tabId = currentAutoTab;
              } else if (p.allowUserTabFallback) {
                const activeTab = this.tabHost.getActiveTab();
                tabId = activeTab?.id;
              } else {
                tabId = this.tabHost.createTab('about:blank', false);
                if (this.tabHost.setAutomationTabId) {
                  this.tabHost.setAutomationTabId(tabId);
                }
              }
            }
            if (tabId && this.tabHost.setAutomationTabId) {
              this.tabHost.setAutomationTabId(tabId);
            }
            const ownerPid = typeof p.ownerPid === 'number' && p.ownerPid > 0 ? p.ownerPid : undefined;
            const res = this.controlPlaneRuntime.createCliSession({
              projectId: typeof p.projectId === 'string' ? p.projectId : undefined,
              workspaceId: typeof p.workspaceId === 'string' ? p.workspaceId : undefined,
              cwd: typeof p.cwd === 'string' ? p.cwd : undefined,
              backendId: p.backendId || 'cli',
              grant: p.grant || 'write',
              tabId,
              browserEpoch: p.browserEpoch,
              ttlMs: typeof p.ttlMs === 'number' ? Math.min(Math.max(p.ttlMs, 10_000), 86_400_000) : 7_200_000,
              ownerPid,
            });
            respond(true, {
              runId: res.run.id,
              attemptId: res.attempt.id,
              attachmentId: res.launch.attachmentId,
              secret: res.launch.secret,
              projectId: res.launch.projectId,
              workspaceId: res.launch.workspaceId,
              host: this.host,
              port: this.port,
              bridgeToken: this.token,
              expiresAt: res.launch.expiresAt,
            });
          } catch (err: unknown) {
            const errorMsg = err instanceof Error ? err.message : String(err);
            respond(false, undefined, errorMsg);
          }
          break;
        }
        case 'antifan.cli.endSession': {
          if (!this.controlPlaneRuntime) {
            respond(false, undefined, 'Control plane runtime is not available');
            break;
          }
          if (!p.runId || !p.attemptId || !p.attachmentId || !p.secret) {
            respond(false, undefined, 'runId, attemptId, attachmentId, and secret are required');
            break;
          }
          try {
            const attachmentRecord = this.controlPlaneRuntime.runs.attachments.getRecord(p.attachmentId);
            if (!attachmentRecord || !this.controlPlaneRuntime.runs.attachments.verifyAttachmentSecret(p.attachmentId, p.secret)) {
              respond(false, undefined, 'Unauthorized: invalid attachment credentials');
              break;
            }
            if (attachmentRecord.runId !== p.runId || attachmentRecord.attemptId !== p.attemptId) {
              respond(false, undefined, 'Lineage mismatch: attachment does not belong to specified run/attempt');
              break;
            }
            if (this.tabHost.clearAllAgentWorking) {
              this.tabHost.clearAllAgentWorking();
            }
            const res = this.controlPlaneRuntime.endCliSession(
              p.runId,
              p.attemptId,
              p.outcome === 'failed' || p.outcome === 'cancelled' ? p.outcome : 'completed',
              p.error
            );
            respond(true, res);
          } catch (err: unknown) {
            const errorMsg = err instanceof Error ? err.message : String(err);
            respond(false, undefined, errorMsg);
          }
          break;
        }
        case 'antifan.cli.renewSession':
        case 'antifan.cli.heartbeat': {
          if (!this.controlPlaneRuntime) {
            respond(false, undefined, 'Control plane runtime is not available');
            break;
          }
          const attachmentId = typeof p.attachmentId === 'string' ? p.attachmentId : undefined;
          const secret = typeof p.secret === 'string' ? p.secret : undefined;
          if (!attachmentId || !secret) {
            respond(false, undefined, 'attachmentId and secret are required for session renewal');
            break;
          }
          try {
            const extensionMs = typeof p.extensionMs === 'number' && p.extensionMs > 0 ? p.extensionMs : undefined;
            const ownerPid = typeof p.ownerPid === 'number' ? p.ownerPid : undefined;
            const res = this.controlPlaneRuntime.renewCliSession(attachmentId, secret, { extensionMs, ownerPid });
            respond(true, res);
          } catch (err: unknown) {
            const errorMsg = err instanceof Error ? err.message : String(err);
            respond(false, undefined, errorMsg);
          }
          break;
        }
        case 'antifan.agentMove': {
          const ok = await this.tabHost.agentMove({ selector: p.selector, ref: p.ref, x: p.x, y: p.y, label: p.label, tabId: p.tabId, paneId: p.paneId });
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
            paneId: p.paneId,
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
          const dom = await this.tabHost.getDom(p.selector, p.tabId, p.paneId);
          respond(true, { html: dom });
          break;
        }

        case 'captureScreenshot':
        case 'antifan.captureScreenshot': {
          const imageBase64 = await this.tabHost.captureScreenshot(p.tabId, p.paneId);
          respond(true, { imageBase64 });
          break;
        }

        case 'evalJS':
        case 'antifan.evalJS': {
          const result = await this.tabHost.evalJs(p.expression, p.tabId, p.paneId);
          respond(true, { result });
          break;
        }
        case 'persistTabs':
        case 'antifan.persistTabs': {
          this.tabHost.persistTabs();
          respond(true, { persisted: true });
          break;
        }

        case 'quit':
        case 'antifan.quit': {
          respond(true, { quitting: true });
          setTimeout(() => {
            try { app.quit(); } catch {}
          }, 100);
          break;
        }

        case 'getStatus':
        case 'antifan.getStatus': {
          respond(true, this.getStatus());
          break;
        }

        case 'getLanIps':
        case 'antifan.getLanIps': {
          respond(true, this.getRemoteConnectionInfo());
          break;
        }

        // ─── Agent Browser Automation & Visual Cursor ───
        case 'agentClick':
        case 'antifan.agentClick': {
          const ok = await this.tabHost.agentClick({
            selector: p.selector,
            ref: p.ref,
            x: p.x,
            y: p.y,
            label: p.label,
            trusted: p.trusted,
            tabId: p.tabId,
            paneId: p.paneId,
          });
          respond(ok, { clicked: ok });
          break;
        }

        case 'agentType':
        case 'antifan.agentType': {
          const ok = await this.tabHost.agentType({
            selector: p.selector,
            ref: p.ref,
            text: p.text,
            clear: p.clear,
            trusted: p.trusted,
            tabId: p.tabId,
            paneId: p.paneId,
          });
          respond(ok, { typed: ok });
          break;
        }

        case 'agentScroll':
        case 'antifan.agentScroll': {
          const ok = await this.tabHost.agentScroll({
            deltaY: p.deltaY,
            selector: p.selector,
            ref: p.ref,
            tabId: p.tabId,
            paneId: p.paneId,
          });
          respond(ok, { scrolled: ok });
          break;
        }

        case 'agentHover':
        case 'antifan.agentHover': {
          const ok = await this.tabHost.agentHover({
            selector: p.selector,
            ref: p.ref,
            x: p.x,
            y: p.y,
            label: p.label,
            tabId: p.tabId,
            paneId: p.paneId,
          });
          respond(ok, { hovered: ok });
          break;
        }

        case 'agentHighlight':
        case 'antifan.agentHighlight': {
          const ok = await this.tabHost.agentHighlight({
            selector: p.selector,
            ref: p.ref,
            label: p.label,
            tabId: p.tabId,
            paneId: p.paneId,
          });
          respond(ok, { highlighted: ok });
          break;
        }

        case 'agentClear':
        case 'antifan.agentClear': {
          const ok = await this.tabHost.agentClear(p.tabId, p.paneId);
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

  private getCongestionState(ws: WebSocket): BridgeCongestionState {
    let state = this.clientCongestion.get(ws);
    if (!state) {
      state = { queue: [], queuedBytes: 0 };
      this.clientCongestion.set(ws, state);
    }
    return state;
  }

  private ensureHeartbeat(): void {
    if (this.heartbeatTimer) return;
    this.heartbeatTimer = setInterval(() => {
      for (const client of this.clients) {
        const hbClient = client as HeartbeatWebSocket;
        if (hbClient.isAlive === false) {
          this.clients.delete(client);
          try { client.terminate(); } catch {}
          continue;
        }
        hbClient.isAlive = false;
        try { client.ping(); } catch {}
      }
    }, BRIDGE_HEARTBEAT_INTERVAL_MS);
    this.heartbeatTimer.unref?.();
  }

  /**
   * Backpressure-aware event send. A healthy client (empty FIFO and socket backlog
   * below the soft high-water mark) gets the frame immediately — unchanged fast
   * path. A slow client queues frames in FIFO order; consecutive terminal-data
   * frames for the same session coalesce (lossless merge: same bytes, same order)
   * and a shared pump drains the FIFO once the socket has room again. The FIFO is
   * hard-capped per client (BRIDGE_QUEUE_HARD_CAP); a client that cannot drain
   * past the cap is terminated — no unbounded buffering, no silent loss (the
   * renderer reconnects and re-syncs terminal state via snapshot).
   */
  private sendEventFrame(ws: WebSocket, event: string, data: unknown, terminalSessionId?: string): void {
    if (ws.readyState !== WebSocket.OPEN) return;

    const raw = JSON.stringify({ event, data } as BridgeEventPayload);
    const bytes = Buffer.byteLength(raw, 'utf8');
    let dataText = '';
    let seq: number | undefined;
    if (terminalSessionId && data && typeof data === 'object') {
      if ('data' in data && data.data !== undefined) {
        dataText = String(data.data ?? '');
      }
      if ('seq' in data && typeof data.seq === 'number') {
        seq = data.seq;
      }
    }

    const state = this.getCongestionState(ws);
    if (state.queue.length === 0 && ws.bufferedAmount + bytes <= BRIDGE_SOFT_HIGH_WATER) {
      try {
        ws.send(raw);
      } catch {
        this.clients.delete(ws);
      }
      return;
    }

    if (terminalSessionId) {
      const last = state.queue[state.queue.length - 1];
      if (last && last.coalesceKey === terminalSessionId) {
        last.data = (last.data ?? '') + dataText;
        if (typeof seq === 'number') {
          last.seq = typeof last.seq === 'number' ? Math.max(last.seq, seq) : seq;
        }
        const mergedRaw = JSON.stringify({
          event: 'antifan:terminal:data',
          data: {
            sessionId: last.sessionId,
            data: last.data,
            ...(typeof last.seq === 'number' ? { seq: last.seq } : {}),
          },
        });
        const newBytes = Buffer.byteLength(mergedRaw, 'utf8');
        const diff = newBytes - last.bytes;
        last.bytes = newBytes;
        state.queuedBytes += diff;
        if (state.queuedBytes > BRIDGE_QUEUE_HARD_CAP) {
          this.dropSlowClient(ws);
        }
        return;
      }
      const initialRaw = JSON.stringify({
        event: 'antifan:terminal:data',
        data: {
          sessionId: terminalSessionId,
          data: dataText,
          ...(typeof seq === 'number' ? { seq } : {}),
        },
      });
      const initialBytes = Buffer.byteLength(initialRaw, 'utf8');
      state.queue.push({ raw: '', bytes: initialBytes, coalesceKey: terminalSessionId, sessionId: terminalSessionId, data: dataText, seq });
      state.queuedBytes += initialBytes;
    } else {
      state.queue.push({ raw, bytes, coalesceKey: null });
      state.queuedBytes += bytes;
    }
    if (state.queuedBytes > BRIDGE_QUEUE_HARD_CAP) {
      this.dropSlowClient(ws);
      return;
    }
    this.armDrainPump();
  }

  private flushCongestedClient(ws: WebSocket): void {
    const state = this.clientCongestion.get(ws);
    if (!state || state.queue.length === 0 || ws.readyState !== WebSocket.OPEN) return;

    while (state.queue.length > 0 && ws.bufferedAmount < BRIDGE_SOFT_HIGH_WATER) {
      const frame = state.queue[0]!;
      const raw = frame.coalesceKey
        ? JSON.stringify({
            event: 'antifan:terminal:data',
            data: {
              sessionId: frame.sessionId,
              data: frame.data,
              ...(typeof frame.seq === 'number' ? { seq: frame.seq } : {}),
            },
          })
        : frame.raw;
      const frameBytes = frame.bytes;
      try {
        ws.send(raw);
      } catch {
        this.clients.delete(ws);
        state.queue = [];
        state.queuedBytes = 0;
        return;
      }
      state.queue.shift();
      state.queuedBytes = Math.max(0, state.queuedBytes - frameBytes);
    }
  }

  private armDrainPump(): void {
    if (this.drainTimer) return;
    this.drainTimer = setInterval(() => {
      let anyCongested = false;
      for (const client of this.clients) {
        const state = this.clientCongestion.get(client);
        if (!state || state.queue.length === 0) continue;
        anyCongested = true;
        this.flushCongestedClient(client);
      }
      if (!anyCongested && this.drainTimer) {
        clearInterval(this.drainTimer);
        this.drainTimer = null;
      }
    }, BRIDGE_DRAIN_INTERVAL_MS);
    this.drainTimer.unref?.();
  }

  /** Terminates a client whose congestion FIFO exceeded the hard cap; observable via socket close + stderr warn. */
  private dropSlowClient(ws: WebSocket): void {
    this.clientCongestion.delete(ws);
    this.clients.delete(ws);
    try { ws.terminate(); } catch {}
    console.warn('[bridge] terminated slow client: congestion queue exceeded hard cap');
  }

  private sendEvent(ws: WebSocket, event: string, data: unknown): void {
    this.sendEventFrame(ws, event, data);
  }

  public broadcastEvent(event: string, data: unknown): void {
    const payload: BridgeEventPayload = { event, data };
    const broadcastStartMs = performance.now();
    const isTerminalData = event === 'antifan:terminal:data';
    const terminalSessionId = isTerminalData && data && typeof data === 'object' && 'sessionId' in data
      ? String(data.sessionId ?? '')
      : undefined;
    let sent = 0;
    let congested = 0;
    for (const client of this.clients) {
      if (client.readyState !== WebSocket.OPEN) continue;
      const state = this.clientCongestion.get(client);
      if (state && state.queue.length > 0) congested += 1;
      if (isTerminalData) {
        this.sendEventFrame(client, event, data, terminalSessionId);
      } else {
        this.sendEventFrame(client, event, data);
      }
      sent += 1;
    }
    if (isBenchmarkEnabled()) {
      recordBenchmark({
        surface: 'bridge',
        name: 'broadcast',
        value: performance.now() - broadcastStartMs,
        extra: { event, clients: sent, congested, bytes: Buffer.byteLength(JSON.stringify(payload), 'utf8') },
      });
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

    try {
      const geminiDir = path.join(os.homedir(), '.gemini');
      const geminiFileName = this.isDev ? 'antifan_bridge_dev.json' : 'antifan_bridge.json';
      const geminiFilePath = path.join(geminiDir, geminiFileName);
      if (fs.existsSync(geminiFilePath)) {
        fs.unlinkSync(geminiFilePath);
      }
    } catch {}

    if (this.drainTimer) {
      clearInterval(this.drainTimer);
      this.drainTimer = null;
    }
    if (this.heartbeatTimer) {
      clearInterval(this.heartbeatTimer);
      this.heartbeatTimer = null;
    }

    for (const client of this.clients) {
      try { client.close(); } catch {}
    }
    this.clients.clear();
    this.wss?.close();
    this.httpServer?.close();
  }
}

function extractAuthToken(req: http.IncomingMessage, url: URL): string | null {
  const authHeader = req.headers['authorization'];
  if (authHeader && typeof authHeader === 'string') {
    const match = authHeader.match(/^Bearer\s+(.+)$/i);
    if (match && match[1]) return match[1].trim();
  }

  const customHeader = req.headers['x-antifan-attachment-secret'];
  if (customHeader && typeof customHeader === 'string') {
    return customHeader.trim();
  }

  const queryToken = url.searchParams.get('token');
  if (queryToken && typeof queryToken === 'string') return queryToken;

  return null;
}
