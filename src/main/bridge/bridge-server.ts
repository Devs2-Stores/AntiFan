/**
 * AntiFan Browser Desktop — Bridge Server (Extension & IDE Companion)
 * Fast, authenticated local WebSocket RPC server bridging between IDE Extension / Agent and Chromium Desktop.
 * Includes Mobile Remote Companion Web App, Live Viewport streaming, and Terminal RPC.
 */
import { app, session } from 'electron';
import { WebSocketServer, WebSocket } from 'ws';
import * as http from 'node:http';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import { StorageLocations } from '../config/storage-locations';
import * as crypto from 'node:crypto';
import { randomUUID } from 'node:crypto';
import { performance } from 'node:perf_hooks';
import { isBenchmarkEnabled, recordBenchmark } from '../benchmark/telemetry';
import { NativeTabHost } from '../browser/native-tab-host';
import { TerminalManager, type SessionSummary } from '../browser/terminal-manager';
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
import { CapabilityRequestContext, CapabilityError, BrowserTarget, RuntimeLease, ArtifactRef, ClientInvocationIntent, makeControlPlaneId, hashSecret, verifySecret } from '../../shared/control-plane-contracts';
import { AttachmentRegistry } from '../run/attachment-registry';
import { enforceProtectedDirectoryDacl, enforceProtectedFileDacl, resolveCurrentUserSid } from '../security/windows-acl';
import { ControlPlaneRuntime } from '../control-plane/control-plane-runtime';
import { deriveCapsulePartition } from '../browser/browser-session-partition';
import { extensionCookieImportSetDetails, type ExtensionCookieInput } from '../browser/chrome-profile-sync';
import { injectedScriptStore } from '../browser/scripts/injected-script-store.js';
export const OFFICIAL_COMPANION_EXTENSION_ID = 'khjcaadjohoclofjkkfblkbfbpmjjedp';

export const DEFAULT_EXTENSION_ALLOWED_DOMAINS: string[] = [
  'haravan.com',
  'myharavan.com',
  'hstatic.net',
  'sapo.vn',
  'mysapo.net',
  'mysapo.vn',
  'bizwebvietnam.net',
  'dktcdn.net',
  'shopify.com',
  'myshopify.com',
];

export interface ExtensionSessionGrant {
  grantToken: string;
  targetPartitionId: string;
  capabilities: ['session.cookies.import'];
  allowedDomains: string[];
  expiresAt: number;
}

export interface PairingRecord {
  codeHash: string;
  clientClass: 'mcp' | 'mobile';
  clientId?: string;
  requestedGrantCeiling?: string;
  ttlMs: number;
  createdAt: number;
  expiresAt: number;
  consumed: boolean;
  consumedAt?: number;
  revoked: boolean;
  attemptBudget: number;
  failedAttempts: number;
}

export interface MobileSessionGrant {
  grantToken: string;
  sessionId: string;
  clientClass: 'mobile';
  clientId?: string;
  issuedAt: number;
  expiresAt: number;
  revoked: boolean;
  allowedScopes: string[];
}

export function redactCredentials(input: string): string {
  if (!input || typeof input !== 'string') return input;
  return input
    .replace(/(Bearer\s+)[A-Za-z0-9._~+/-]+=*/gi, '$1[REDACTED]')
    .replace(/(x-antifan-attachment-secret:\s*)[A-Za-z0-9._~+/-]+=*/gi, '$1[REDACTED]')
    .replace(/(token=)[^& \t\r\n"']+/gi, '$1[REDACTED]')
    .replace(/(secret=)[^& \t\r\n"']+/gi, '$1[REDACTED]')
    .replace(/(pairingCode=)[^& \t\r\n"']+/gi, '$1[REDACTED]')
    .replace(/(code=)[^& \t\r\n"']+/gi, '$1[REDACTED]')
    .replace(/([?&](?:token|secret|code|key)=)[^& \t\r\n"']+/gi, '$1[REDACTED]')
    .replace(/("token"\s*:\s*")[^"]+(")/gi, '$1[REDACTED]$2')
    .replace(/("secret"\s*:\s*")[^"]+(")/gi, '$1[REDACTED]$2')
    .replace(/("code"\s*:\s*")[^"]+(")/gi, '$1[REDACTED]$2');
}

export function applyProtectedFileDacl(filePath: string): void {
  if (process.platform !== 'win32') return;
  try {
    if (typeof enforceProtectedFileDacl === 'function') {
      const sid = typeof resolveCurrentUserSid === 'function' ? resolveCurrentUserSid() : undefined;
      enforceProtectedFileDacl(filePath, sid);
    }
  } catch {
    // Non-fatal in non-elevated or mock test environments
  }
}

export function isAuthorizedCompanionOrigin(rawOrigin: string): boolean {
  if (!rawOrigin || typeof rawOrigin !== 'string') return false;
  if (!rawOrigin.startsWith('chrome-extension://')) return false;
  const extId = rawOrigin.replace('chrome-extension://', '').replace(/\/.*$/, '').trim().toLowerCase();
  return extId === OFFICIAL_COMPANION_EXTENSION_ID;
}
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
  private readonly extensionGrants: Map<string, ExtensionSessionGrant> = new Map();
  private readonly pairingStore: Map<string, PairingRecord> = new Map();
  private readonly mobileGrants: Map<string, MobileSessionGrant> = new Map();
  private readonly socketMobileGrantIds: WeakMap<WebSocket, string> = new WeakMap();
  private readonly socketMobileGrants: WeakMap<WebSocket, MobileSessionGrant> = new WeakMap();
  private readonly socketBridgeTokens: WeakSet<WebSocket> = new WeakSet();
  private lanOptIn: boolean = false;
  private pairingQueueDir: string;

  public issueExtensionGrant(targetPartitionId: string, allowedDomains: string[] = DEFAULT_EXTENSION_ALLOWED_DOMAINS, ttlMs = 3600_000): ExtensionSessionGrant {
    this.pruneExpiredGrants();
    const grantToken = randomUUID();
    const grant: ExtensionSessionGrant = {
      grantToken,
      targetPartitionId,
      capabilities: ['session.cookies.import'],
      allowedDomains,
      expiresAt: Date.now() + ttlMs,
    };
    this.extensionGrants.set(grantToken, grant);
    return grant;
  }

  public getExtensionGrant(token: string): { grant: ExtensionSessionGrant; isExpired: boolean } | null {
    if (!token) return null;
    const grant = this.extensionGrants.get(token);
    if (!grant) return null;
    if (Date.now() > grant.expiresAt) {
      return { grant, isExpired: true };
    }
    return { grant, isExpired: false };
  }

  public pruneExpiredGrants(): void {
    const now = Date.now();
    for (const [token, grant] of this.extensionGrants.entries()) {
      if (now - grant.expiresAt > 300_000) { // Prune 5 mins after expiry
        this.extensionGrants.delete(token);
      }
    }
  }

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
    this.pairingQueueDir = path.join(StorageLocations.getRuntimeDir(), 'pairing-queue');
    BridgeServer.instance = this;
    this.wireTabHostEvents();
    this.replenishPairingQueue();
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

  public setLanOptIn(optIn: boolean): void {
    this.lanOptIn = Boolean(optIn);
  }

  public isLanOptIn(): boolean {
    return this.lanOptIn;
  }

  public issuePairingCode(options: {
    clientClass: 'mcp' | 'mobile';
    clientId?: string;
    requestedGrantCeiling?: string;
    ttlMs?: number;
    attemptBudget?: number;
  }): { code: string; expiresAt: number; codeHash: string } {
    this.pruneExpiredPairingsAndGrants();
    const code = crypto.randomBytes(16).toString('hex');
    const codeHash = hashSecret(code);
    const now = Date.now();
    const ttlMs = typeof options.ttlMs === 'number' ? Math.max(10_000, options.ttlMs) : 300_000;
    const record: PairingRecord = {
      codeHash,
      clientClass: options.clientClass,
      clientId: options.clientId,
      requestedGrantCeiling: options.requestedGrantCeiling,
      ttlMs,
      createdAt: now,
      expiresAt: now + ttlMs,
      consumed: false,
      revoked: false,
      attemptBudget: options.attemptBudget ?? 3,
      failedAttempts: 0,
    };
    this.pairingStore.set(codeHash, record);
    return { code, expiresAt: record.expiresAt, codeHash };
  }

  public getMobileGrant(token: string): MobileSessionGrant | null {
    if (!token) return null;
    const grant = this.mobileGrants.get(token);
    if (!grant || grant.revoked) return null;
    if (Date.now() > grant.expiresAt) return null;
    return grant;
  }

  public pruneExpiredPairingsAndGrants(): void {
    const now = Date.now();
    for (const [hash, record] of this.pairingStore.entries()) {
      if (now > record.expiresAt + 60_000 || record.consumed || record.revoked) {
        this.pairingStore.delete(hash);
      }
    }
    for (const [token, grant] of this.mobileGrants.entries()) {
      if (now > grant.expiresAt + 60_000 || grant.revoked) {
        this.mobileGrants.delete(token);
      }
    }
  }

  public replenishPairingQueue(): void {
    try {
      if (!fs.existsSync(this.pairingQueueDir)) {
        fs.mkdirSync(this.pairingQueueDir, { recursive: true });
        if (process.platform === 'win32') {
          try {
            const sid = resolveCurrentUserSid();
            enforceProtectedDirectoryDacl(this.pairingQueueDir, sid);
          } catch {}
        }
      }

      const existing = fs.readdirSync(this.pairingQueueDir);
      let activeCount = 0;
      const now = Date.now();
      for (const file of existing) {
        if (!file.endsWith('.json')) continue;
        const filePath = path.join(this.pairingQueueDir, file);
        try {
          const raw = fs.readFileSync(filePath, 'utf8');
          const data = JSON.parse(raw);
          if (!data || !data.code || !data.expiresAt || now > data.expiresAt) {
            fs.unlinkSync(filePath);
          } else {
            activeCount++;
          }
        } catch {
          try { fs.unlinkSync(filePath); } catch {}
        }
      }

      const needed = Math.max(0, 3 - activeCount);
      for (let i = 0; i < needed; i++) {
        const pairing = this.issuePairingCode({
          clientClass: 'mcp',
          ttlMs: 600_000,
        });
        const challengeId = randomUUID();
        const challengeData = {
          challengeId,
          code: pairing.code,
          clientClass: 'mcp',
          expiresAt: pairing.expiresAt,
          port: this.port,
          host: this.host,
        };
        const challengePath = path.join(this.pairingQueueDir, `challenge-${challengeId}.json`);
        this.atomicWriteWithDacl(challengePath, JSON.stringify(challengeData, null, 2));
      }
    } catch {}
  }

  public claimPairingChallenge(clientClass: 'mcp' | 'mobile' = 'mcp'): { code: string; expiresAt: number; challengeId?: string } | null {
    try {
      if (!fs.existsSync(this.pairingQueueDir)) return null;
      const files = fs.readdirSync(this.pairingQueueDir).filter(f => f.startsWith('challenge-') && f.endsWith('.json'));
      const now = Date.now();
      let hasExpiredOrCorrupt = false;
      for (const file of files) {
        const filePath = path.join(this.pairingQueueDir, file);
        let raw: string;
        try {
          raw = fs.readFileSync(filePath, 'utf8');
        } catch {
          continue;
        }
        let data: { code?: string; expiresAt?: number; clientClass?: string; challengeId?: string } | null = null;
        try {
          data = JSON.parse(raw) as { code?: string; expiresAt?: number; clientClass?: string; challengeId?: string };
        } catch {
          try { fs.unlinkSync(filePath); } catch {}
          hasExpiredOrCorrupt = true;
          continue;
        }

        if (!data || !data.code || typeof data.expiresAt !== 'number' || now > data.expiresAt) {
          try { fs.unlinkSync(filePath); } catch {}
          hasExpiredOrCorrupt = true;
          continue;
        }

        // Verify clientClass BEFORE unlinking/claiming so other client classes are not destroyed
        if (clientClass && data.clientClass && data.clientClass !== clientClass) {
          continue;
        }

        // Atomic claim via unique rename
        const claimPath = path.join(this.pairingQueueDir, `${file}.claimed.${process.pid}.${Date.now()}.${Math.random().toString(16).slice(2)}`);
        try {
          fs.renameSync(filePath, claimPath);
        } catch {
          // Raced with another process
          continue;
        }
        try {
          fs.unlinkSync(claimPath);
        } catch {}

        setImmediate(() => this.replenishPairingQueue());
        return { code: data.code, expiresAt: data.expiresAt, challengeId: data.challengeId };
      }

      // Schedule replenishment on expiry / empty queue to prevent queue starvation
      if (hasExpiredOrCorrupt || files.length === 0) {
        setImmediate(() => this.replenishPairingQueue());
      }
    } catch {}
    return null;
  }

  private atomicWriteWithDacl(targetPath: string, content: string): void {
    const parentDir = path.dirname(targetPath);
    if (!fs.existsSync(parentDir)) {
      fs.mkdirSync(parentDir, { recursive: true });
    }
    const tempPath = path.join(parentDir, `.${path.basename(targetPath)}.tmp.${Date.now()}-${Math.random().toString(16).slice(2)}`);
    // Create empty temp file first and lock DACL before writing sensitive secret payload
    fs.writeFileSync(tempPath, '', { encoding: 'utf8', mode: 0o600 });
    applyProtectedFileDacl(tempPath);
    fs.writeFileSync(tempPath, content, { encoding: 'utf8', mode: 0o600 });
    fs.renameSync(tempPath, targetPath);
    applyProtectedFileDacl(targetPath);
  }

  public getRemoteConnectionInfo(): {
    port: number;
    lanIps: string[];
    urls: string[];
    primaryUrl: string;
    qrSvg: string;
    pairingCode: string;
    pairingExpiresAt: number;
    lanOptIn: boolean;
    firewallGuidance: string;
  } {
    const lanIps = getLocalLanIps();
    const effectiveIps = this.lanOptIn ? lanIps : ['127.0.0.1'];
    const urls = effectiveIps.map(ip => `http://${ip}:${this.port}/mobile`);
    const primaryUrl = urls[0] || `http://127.0.0.1:${this.port}/mobile`;
    const qrSvg = generateQrSvg(primaryUrl);
    const pairing = this.issuePairingCode({
      clientClass: 'mobile',
      ttlMs: 300_000,
    });
    const firewallGuidance = this.lanOptIn
      ? `LAN access is enabled. Ensure Windows Firewall permits inbound TCP traffic on port ${this.port}.`
      : `Mobile remote is restricted to loopback (127.0.0.1). Enable LAN opt-in in settings to allow devices on your Wi-Fi network.`;

    return {
      port: this.port,
      lanIps: effectiveIps,
      urls,
      primaryUrl,
      qrSvg,
      pairingCode: pairing.code,
      pairingExpiresAt: pairing.expiresAt,
      lanOptIn: this.lanOptIn,
      firewallGuidance,
    };
  }

  private createHttpHandler(): (req: http.IncomingMessage, res: http.ServerResponse) => void {
    return async (req, res) => {
      const host = req.headers.host || `127.0.0.1:${this.port}`;
      const reqUrl = new URL(req.url || '/', `http://${host}`);
      const pathname = reqUrl.pathname;
      // 1. Strict Query Parameter Prohibition (SECRETS_IN_URL_FORBIDDEN)
      if (reqUrl.searchParams.has('token') || reqUrl.searchParams.has('secret') || reqUrl.searchParams.has('code') || (reqUrl.search && /token=|secret=|code=/i.test(reqUrl.search))) {
        res.writeHead(401, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Unauthorized: SECRETS_IN_URL_FORBIDDEN - Tokens in URL query string are strictly prohibited' }));
        return;
      }

      // 2. Loopback-by-default boundary enforcement
      const remoteIp = req.socket.remoteAddress || '';
      const isLoopback = remoteIp === '127.0.0.1' || remoteIp === '::1' || remoteIp === '::ffff:127.0.0.1';
      if (!this.lanOptIn && !isLoopback && pathname !== '/favicon.ico') {
        res.writeHead(403, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'LAN_ACCESS_FORBIDDEN', message: 'LAN access is disabled. Enable LAN opt-in in desktop settings.' }));
        return;
      }

      const clientToken = extractAuthToken(req);
      const isBridgeToken = Boolean(clientToken && clientToken === this.token);
      const verifiedAttachmentId = clientToken ? (this.attachmentRegistry?.verifyConnectionToken(clientToken) ?? null) : null;
      const verifiedMobileGrant = clientToken ? this.getMobileGrant(clientToken) : null;
      const extensionGrantLookup = clientToken ? this.getExtensionGrant(clientToken) : null;
      const isExpiredGrant = Boolean(extensionGrantLookup?.isExpired);
      const verifiedExtensionGrant = extensionGrantLookup && !extensionGrantLookup.isExpired ? extensionGrantLookup.grant : null;
      const rawOrigin = typeof req.headers.origin === 'string' ? req.headers.origin : '';
      let isAllowedOrigin = false;
      if (rawOrigin) {
        if (rawOrigin.startsWith('chrome-extension://')) {
          isAllowedOrigin = isAuthorizedCompanionOrigin(rawOrigin);
        } else {
          try {
            const parsedOrigin = new URL(rawOrigin);
            isAllowedOrigin = parsedOrigin.hostname === 'localhost' || parsedOrigin.hostname === '127.0.0.1';
          } catch {
            isAllowedOrigin = false;
          }
        }
      }
      if (req.method === 'OPTIONS') {
        if (pathname === '/api/cookies/import' && rawOrigin && !isAllowedOrigin) {
          res.writeHead(403, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: 'FORBIDDEN_ORIGIN', message: 'Cross-origin requests from unauthorized origins are forbidden.' }));
          return;
        }
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

      if (pathname === '/api/pairing/exchange' && req.method === 'POST') {
        let body = '';
        let size = 0;
        const MAX_BODY_SIZE = 64 * 1024;
        let isTooLarge = false;

        req.on('data', (chunk) => {
          size += chunk.length;
          if (size > MAX_BODY_SIZE) {
            isTooLarge = true;
            res.writeHead(413, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ error: 'PAYLOAD_TOO_LARGE', message: 'Pairing payload exceeds maximum allowed size' }));
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
            const { code, clientClass, clientId, requestedGrant } = data;

            if (!code || typeof code !== 'string' || !clientClass || typeof clientClass !== 'string') {
              res.writeHead(400, responseHeaders);
              res.end(JSON.stringify({ error: 'INVALID_PAIRING_REQUEST', message: 'Missing required code or clientClass' }));
              return;
            }

            if (clientClass !== 'mcp' && clientClass !== 'mobile') {
              res.writeHead(400, responseHeaders);
              res.end(JSON.stringify({ error: 'INVALID_CLIENT_CLASS', message: "clientClass must be 'mcp' or 'mobile'" }));
              return;
            }

            const trimmedCode = code.trim();
            const codeHash = hashSecret(trimmedCode);
            const record = this.pairingStore.get(codeHash);

            if (!record) {
              res.writeHead(401, responseHeaders);
              res.end(JSON.stringify({ error: 'PAIRING_CODE_NOT_FOUND', message: 'Pairing code not found or invalid' }));
              return;
            }

            if (record.revoked) {
              res.writeHead(403, responseHeaders);
              res.end(JSON.stringify({ error: 'PAIRING_CODE_REVOKED', message: 'Pairing code has been revoked' }));
              return;
            }

            if (record.consumed) {
              res.writeHead(409, responseHeaders);
              res.end(JSON.stringify({ error: 'PAIRING_CODE_ALREADY_USED', message: 'Pairing code has already been consumed (replay rejected)' }));
              return;
            }

            if (Date.now() > record.expiresAt) {
              res.writeHead(410, responseHeaders);
              res.end(JSON.stringify({ error: 'PAIRING_CODE_EXPIRED', message: 'Pairing code has expired' }));
              return;
            }

            if (record.failedAttempts >= record.attemptBudget) {
              record.revoked = true;
              res.writeHead(429, responseHeaders);
              res.end(JSON.stringify({ error: 'PAIRING_ATTEMPTS_EXCEEDED', message: 'Pairing code attempt budget exceeded; code revoked' }));
              return;
            }

            if (record.clientClass !== clientClass) {
              record.failedAttempts++;
              res.writeHead(403, responseHeaders);
              res.end(JSON.stringify({
                error: 'PAIRING_CLIENT_CLASS_MISMATCH',
                message: `Pairing code intended for client class '${record.clientClass}', received '${clientClass}'`,
              }));
              return;
            }

            if (record.clientId && clientId && record.clientId !== clientId) {
              record.failedAttempts++;
              res.writeHead(403, responseHeaders);
              res.end(JSON.stringify({ error: 'PAIRING_CLIENT_ID_MISMATCH', message: 'Client ID does not match bound pairing record' }));
              return;
            }

            const grantRanks: Record<string, number> = { read: 1, write: 2, execute: 3, eval: 4 };
            if (requestedGrant && record.requestedGrantCeiling) {
              const requestedRank = grantRanks[requestedGrant] ?? 99;
              const ceilingRank = grantRanks[record.requestedGrantCeiling] ?? 0;
              if (requestedRank > ceilingRank) {
                record.failedAttempts++;
                res.writeHead(403, responseHeaders);
                res.end(JSON.stringify({
                  error: 'PAIRING_GRANT_CEILING_EXCEEDED',
                  message: `Requested grant '${requestedGrant}' exceeds grant ceiling '${record.requestedGrantCeiling}'`,
                }));
                return;
              }
            }

            record.consumed = true;
            record.consumedAt = Date.now();

            if (clientClass === 'mcp') {
              if (!this.attachmentRegistry) {
                res.writeHead(503, responseHeaders);
                res.end(JSON.stringify({ error: 'ATTACHMENT_REGISTRY_UNAVAILABLE', message: 'Attachment registry is not configured' }));
                return;
              }

              const runId = makeControlPlaneId('run');
              const attemptId = makeControlPlaneId('attempt');
              const binding = this.runtimeBindingProvider ? this.runtimeBindingProvider() : undefined;
              const projectId = binding?.projectId || 'default-project';
              const workspaceId = binding?.workspaceId || 'default-workspace';
              const lease = binding?.lease || {
                runtimeId: makeControlPlaneId('runtime'),
                projectId,
                workspaceId,
                token: randomUUID(),
                protocolVersion: 1,
                hostEpoch: 1,
                ownerPid: process.pid,
                issuedAt: Date.now(),
                expiresAt: Date.now() + 3_600_000,
              };
              const grant = (requestedGrant || record.requestedGrantCeiling || 'write') as 'read' | 'write' | 'execute' | 'eval';
              const { launch } = await this.attachmentRegistry.issueAttachment(
                runId,
                attemptId,
                projectId,
                workspaceId,
                {
                  backendId: 'mcp',
                  lease,
                  leaseToken: lease.token,
                  grant,
                  browserTarget: binding?.browserTarget,
                  ttlMs: 3_600_000,
                }
              );

              res.writeHead(200, responseHeaders);
              res.end(JSON.stringify({
                success: true,
                clientClass: 'mcp',
                attachmentId: launch.attachmentId,
                secret: launch.secret,
                authorityRevision: launch.authorityRevision,
                runId,
                attemptId,
                projectId,
                workspaceId,
                host: this.host,
                port: this.port,
                expiresAt: launch.expiresAt,
                grant,
              }));
              return;
            }

            if (clientClass === 'mobile') {
              const grantToken = crypto.randomBytes(32).toString('hex');
              const sessionId = makeControlPlaneId('session');
              const now = Date.now();
              const ttlMs = 8 * 3600_000;
              const expiresAt = now + ttlMs;
              const grant: MobileSessionGrant = {
                grantToken,
                sessionId,
                clientClass: 'mobile',
                clientId: typeof clientId === 'string' ? clientId : undefined,
                issuedAt: now,
                expiresAt,
                revoked: false,
                allowedScopes: ['terminal.sync', 'terminal.input', 'tabs.view'],
              };
              this.mobileGrants.set(grantToken, grant);

              res.writeHead(200, {
                ...responseHeaders,
                'Set-Cookie': `antifan_mobile_token=${grantToken}; Path=/; HttpOnly; SameSite=Strict`,
              });
              res.end(JSON.stringify({
                success: true,
                clientClass: 'mobile',
                token: grantToken,
                sessionId,
                expiresAt,
                allowedScopes: grant.allowedScopes,
              }));
              return;
            }
          } catch (err: unknown) {
            const errorMsg = err instanceof Error ? err.message : String(err);
            res.writeHead(400, responseHeaders);
            res.end(JSON.stringify({ error: 'INVALID_JSON_BODY', message: redactCredentials(errorMsg) }));
          }
        });
        return;
      }

      if (pathname === '/api/pairing/challenge' && (req.method === 'POST' || req.method === 'GET')) {
        if (!isLoopback) {
          res.writeHead(403, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: 'FORBIDDEN', message: 'Pairing challenge claims are restricted to loopback callers' }));
          return;
        }
        const challenge = this.claimPairingChallenge('mcp');
        const responseHeaders: Record<string, string> = { 'Content-Type': 'application/json' };
        if (isAllowedOrigin) responseHeaders['Access-Control-Allow-Origin'] = rawOrigin;

        if (!challenge) {
          res.writeHead(404, responseHeaders);
          res.end(JSON.stringify({
            error: 'CHALLENGE_QUEUE_DEPLETED',
            message: 'No pending pairing challenges available on disk queue',
          }));
          return;
        }

        res.writeHead(200, responseHeaders);
        res.end(JSON.stringify({
          success: true,
          code: challenge.code,
          expiresAt: challenge.expiresAt,
          clientClass: 'mcp',
        }));
        return;
      }


      if (
        pathname === '/api/screenshot' ||
        pathname === '/api/remote-info' ||
        pathname === '/api/qr' ||
        pathname === '/api/cookies/import' ||
        pathname === '/api/lan-ips' ||
        pathname === '/status'
      ) {
        if (isExpiredGrant) {
          const expiredHeaders: Record<string, string> = { 'Content-Type': 'application/json' };
          if (isAllowedOrigin) expiredHeaders['Access-Control-Allow-Origin'] = rawOrigin;
          res.writeHead(401, expiredHeaders);
          res.end(JSON.stringify({ error: 'EXPIRED_GRANT', message: 'Extension session grant has expired. Please re-authenticate via Native Host.' }));
          return;
        }
        if (verifiedExtensionGrant && pathname !== '/api/cookies/import' && pathname !== '/status') {
          const forbiddenHeaders: Record<string, string> = { 'Content-Type': 'application/json' };
          if (isAllowedOrigin) forbiddenHeaders['Access-Control-Allow-Origin'] = rawOrigin;
          res.writeHead(403, forbiddenHeaders);
          res.end(JSON.stringify({ error: 'FORBIDDEN', message: 'Extension grants are restricted to cookie importation and status checks.' }));
          return;
        }
        if (!isBridgeToken && !verifiedAttachmentId && !verifiedExtensionGrant && !verifiedMobileGrant) {
          const unauthHeaders: Record<string, string> = { 'Content-Type': 'application/json' };
          if (isAllowedOrigin) unauthHeaders['Access-Control-Allow-Origin'] = rawOrigin;
          res.writeHead(401, unauthHeaders);
          res.end(JSON.stringify({ error: 'Unauthorized: missing or invalid token' }));
          return;
        }
      }
      if (pathname === '/status') {
        const headers: Record<string, string> = { 'Content-Type': 'application/json' };
        if (isAllowedOrigin) headers['Access-Control-Allow-Origin'] = rawOrigin;
        res.writeHead(200, headers);
        res.end(JSON.stringify(this.getStatus()));
        return;
      }

      if (pathname === '/api/lan-ips' || pathname === '/api/remote-info') {
        const headers: Record<string, string> = { 'Content-Type': 'application/json' };
        if (isAllowedOrigin) headers['Access-Control-Allow-Origin'] = rawOrigin;
        res.writeHead(200, headers);
        res.end(JSON.stringify(this.getRemoteConnectionInfo()));
        return;
      }

      if (pathname === '/api/qr') {
        const info = this.getRemoteConnectionInfo();
        const headers: Record<string, string> = { 'Content-Type': 'image/svg+xml' };
        if (isAllowedOrigin) headers['Access-Control-Allow-Origin'] = rawOrigin;
        res.writeHead(200, headers);
        res.end(info.qrSvg);
        return;
      }

      if (pathname === '/api/screenshot') {
        try {
          const imgBase64 = await this.tabHost.captureScreenshot();
          const imgBuf = Buffer.from(imgBase64, 'base64');
          const headers: Record<string, string> = { 'Content-Type': 'image/png' };
          if (isAllowedOrigin) headers['Access-Control-Allow-Origin'] = rawOrigin;
          res.writeHead(200, headers);
          res.end(imgBuf);
        } catch {
          res.writeHead(500);
          res.end('Failed to capture screenshot');
        }
        return;
      }

      if (pathname.startsWith('/api/artifacts/')) {
        if (req.method !== 'GET') {
          res.writeHead(405, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: 'Method Not Allowed' }));
          return;
        }

        // 1. Strict Query Parameter Prohibition (SECRETS_IN_URL_FORBIDDEN)
        if (reqUrl.searchParams.has('token') || (reqUrl.search && reqUrl.search.includes('token='))) {
          res.writeHead(401, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: 'Unauthorized: SECRETS_IN_URL_FORBIDDEN - Tokens in URL query string are strictly prohibited' }));
          return;
        }

        // 2. Strict Single-Header Authentication (x-antifan-attachment-secret)
        const secretHeader = req.headers['x-antifan-attachment-secret'];
        const secret = typeof secretHeader === 'string' ? secretHeader.trim() : (Array.isArray(secretHeader) ? secretHeader[0]?.trim() : null);

        if (!secret) {
          res.writeHead(401, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: 'Unauthorized: ATTACHMENT_SECRET_REQUIRED - Missing x-antifan-attachment-secret header' }));
          return;
        }

        if (!this.attachmentRegistry) {
          res.writeHead(503, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: 'Service Unavailable: Attachment registry not configured' }));
          return;
        }

        const verifiedAttachmentId = this.attachmentRegistry.verifyConnectionToken(secret);
        if (!verifiedAttachmentId) {
          res.writeHead(401, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: 'Unauthorized: Invalid or expired attachment secret' }));
          return;
        }

        const record = this.attachmentRegistry.getAttachment(verifiedAttachmentId);
        if (!record || record.state !== 'active' || Date.now() > record.expiresAt) {
          res.writeHead(401, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: 'Unauthorized: Inactive or expired attachment record' }));
          return;
        }

        const artifactId = pathname.slice('/api/artifacts/'.length).trim();
        if (!artifactId) {
          res.writeHead(400, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: 'Bad Request: Artifact ID is required' }));
          return;
        }

        if (!this.controlPlaneRuntime?.artifacts) {
          res.writeHead(503, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: 'Service Unavailable: Artifact store not available' }));
          return;
        }

        let ref: ArtifactRef;
        let data: Buffer;
        try {
          const resObj = this.controlPlaneRuntime.artifacts.readBytesById(artifactId);
          ref = resObj.ref;
          data = resObj.data;
        } catch (err: unknown) {
          const message = err instanceof Error ? err.message : String(err);
          const isContainment = err instanceof CapabilityError && err.code === 'OUTSIDE_WORKSPACE';
          res.writeHead(isContainment ? 403 : 404, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: message }));
          return;
        }

        // 3. Mandatory Lineage & Ownership Validation: Zero bypass
        if (ref.runId !== record.runId || ref.attemptId !== record.attemptId) {
          res.writeHead(403, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: 'Forbidden: ATTACHMENT_MISMATCH - Artifact run/attempt does not match attachment record' }));
          return;
        }
        if (record.projectId && ref.projectId && ref.projectId !== record.projectId) {
          res.writeHead(403, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: 'Forbidden: ATTACHMENT_MISMATCH - Artifact projectId does not match attachment record' }));
          return;
        }
        if (record.workspaceId && ref.workspaceId && ref.workspaceId !== record.workspaceId) {
          res.writeHead(403, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: 'Forbidden: ATTACHMENT_MISMATCH - Artifact workspaceId does not match attachment record' }));
          return;
        }

        // 4. Truncation Defense: Allow partial text/DOM retrieval with truncation header, fail-closed on corrupt binary images
        const isImage = typeof ref.mime === 'string' && ref.mime.startsWith('image/');
        if (ref.truncated === true && isImage) {
          res.writeHead(422, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: 'Unprocessable Entity: PAYLOAD_TRUNCATED - Image payload was truncated' }));
          return;
        }
        // 5. Stream Binary Payload (with 1 MiB chunking support)
        const hasChunkParams = reqUrl.searchParams.has('offset') || reqUrl.searchParams.has('limit');
        if (hasChunkParams || data.byteLength > 1024 * 1024) {
          const offsetParam = reqUrl.searchParams.get('offset');
          const limitParam = reqUrl.searchParams.get('limit');
          const offset = offsetParam ? Math.max(0, parseInt(offsetParam, 10) || 0) : 0;
          const maxChunk = 1024 * 1024;
          const limit = limitParam ? Math.min(Math.max(1, parseInt(limitParam, 10) || maxChunk), maxChunk) : maxChunk;
          const chunk = data.subarray(offset, offset + limit);
          const hasMore = offset + chunk.byteLength < data.byteLength;

          res.writeHead(200, {
            'Content-Type': ref.mime || 'application/octet-stream',
            'Content-Length': String(chunk.byteLength),
            'X-Artifact-Id': ref.id,
            'X-Artifact-Sha256': ref.sha256 || '',
            'X-Artifact-Offset': String(offset),
            'X-Artifact-Limit': String(chunk.byteLength),
            'X-Artifact-Total-Bytes': String(data.byteLength),
            'X-Artifact-Has-More': String(hasMore),
            'X-Artifact-Truncated': ref.truncated ? 'true' : 'false',
            'Access-Control-Allow-Origin': isAllowedOrigin ? rawOrigin : 'http://127.0.0.1',
          });
          res.end(chunk);
          return;
        }

        res.writeHead(200, {
          'Content-Type': ref.mime || 'application/octet-stream',
          'Content-Length': String(data.byteLength),
          'X-Artifact-Id': ref.id,
          'X-Artifact-Sha256': ref.sha256 || '',
          'X-Artifact-Truncated': ref.truncated ? 'true' : 'false',
          'Access-Control-Allow-Origin': isAllowedOrigin ? rawOrigin : 'http://127.0.0.1',
        });
        res.end(data);
        return;
      }

      if (pathname === '/' || pathname === '/mobile' || pathname === '/remote') {
        if (verifiedAttachmentId && !isBridgeToken && !verifiedMobileGrant) {
          res.writeHead(403, { 'Content-Type': 'text/plain; charset=utf-8' });
          res.end('Forbidden: Attachment tokens cannot access administrative mobile companion');
          return;
        }
        const html = renderMobileRemoteHtml(this.port);
        res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
        res.end(html);
        return;
      }

      if (pathname === '/api/cookies/import' && req.method === 'POST') {
        if (rawOrigin && !isAllowedOrigin) {
          res.writeHead(403, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ success: false, error: 'FORBIDDEN_ORIGIN', message: 'Cross-origin requests from non-loopback origins are forbidden.' }));
          return;
        }
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
            const rawRemoved = Array.isArray(data.removed) ? data.removed : [];
            if (rawRemoved.length > 0) {
              res.writeHead(400, responseHeaders);
              res.end(JSON.stringify({
                success: false,
                error: 'REMOVALS_UNSUPPORTED',
                message: 'Cookie removal propagation is unsupported. This endpoint only supports one-way additive cookie hydration.',
              }));
              return;
            }
            const rawCookies: ExtensionCookieInput[] = Array.isArray(data.cookies)
              ? data.cookies
              : (Array.isArray(data.upserted) ? data.upserted : []);
            const requestedPartition = typeof data.partition === 'string' && data.partition.trim()
              ? data.partition.trim()
              : (typeof data.targetPartition === 'string' && data.targetPartition.trim()
                ? data.targetPartition.trim()
                : (typeof data.targetCapsuleId === 'string' && data.targetCapsuleId.trim()
                  ? deriveCapsulePartition(data.targetCapsuleId.trim())
                  : (typeof data.capsuleId === 'string' && data.capsuleId.trim()
                    ? deriveCapsulePartition(data.capsuleId.trim())
                    : null)));
            if (data.source === 'chrome-extension-delta' && !requestedPartition) {
              res.writeHead(400, responseHeaders);
              res.end(JSON.stringify({
                success: false,
                error: 'MISSING_TARGET_PARTITION',
                message: 'Explicit targetPartition or targetCapsuleId is required for background delta sync.',
              }));
              return;
            }
            let targetSession: Electron.Session;
            let resolvedTargetTabId: string | null = null;
            if (verifiedExtensionGrant) {
              if (requestedPartition && requestedPartition !== verifiedExtensionGrant.targetPartitionId) {
                res.writeHead(403, responseHeaders);
                res.end(JSON.stringify({
                  success: false,
                  error: 'FORBIDDEN_PARTITION',
                  message: `Extension grant is strictly bound to partition "${verifiedExtensionGrant.targetPartitionId}", cannot target "${requestedPartition}".`,
                }));
                return;
              }
              const pinnedPartition = verifiedExtensionGrant.targetPartitionId;
              if (!this.tabHost.isValidCapsulePartition(pinnedPartition)) {
                res.writeHead(404, responseHeaders);
                res.end(JSON.stringify({ success: false, error: 'UNKNOWN_TARGET_PARTITION', message: `Partition "${pinnedPartition}" is not an active or registered capsule session.` }));
                return;
              }
              targetSession = this.tabHost.getPartitionSession(pinnedPartition);
            } else if (verifiedAttachmentId && !isBridgeToken) {
              if (requestedPartition) {
                res.writeHead(403, responseHeaders);
                res.end(JSON.stringify({ success: false, error: 'Forbidden: attachment tokens cannot target arbitrary partitions' }));
                return;
              }
              const registry = this.attachmentRegistry || this.controlPlaneRuntime?.runs?.attachments;
              const attachmentRecord = registry?.getRecord(verifiedAttachmentId);
              const boundTabId = attachmentRecord?.tabId || attachmentRecord?.browserTarget?.tabId;
              const explicitTabId = typeof data.tabId === 'string' && data.tabId.trim() ? data.tabId.trim() : undefined;
              if (explicitTabId && boundTabId && explicitTabId !== boundTabId) {
                res.writeHead(403, responseHeaders);
                res.end(JSON.stringify({ success: false, error: `Forbidden: attachment token bound to tab "${boundTabId}", cannot target "${data.tabId}"` }));
                return;
              }
              const targetTabId = boundTabId || explicitTabId;
              if (!targetTabId) {
                res.writeHead(400, responseHeaders);
                res.end(JSON.stringify({ success: false, error: 'TARGET_REQUIRED', message: 'TARGET_REQUIRED: Attachment token has no bound tab and no explicit tabId was specified.' }));
                return;
              }
              resolvedTargetTabId = targetTabId;
              if (!this.hostTabExists(targetTabId)) {
                res.writeHead(400, responseHeaders);
                res.end(JSON.stringify({ success: false, error: 'TARGET_CLOSED', message: `TARGET_CLOSED: Target tab "${targetTabId}" not found or destroyed` }));
                return;
              }
              const tabSession = this.tabHost.getTabSession(targetTabId);
              if (!tabSession) {
                res.writeHead(400, responseHeaders);
                res.end(JSON.stringify({ success: false, error: 'TARGET_CLOSED', message: `TARGET_CLOSED: Target tab "${targetTabId}" session not found or destroyed` }));
                return;
              }
              targetSession = tabSession;
            } else {
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
            let skippedCount = 0;
            let failedCount = 0;

            const persistSession = data.persistSessionCookies !== false;
            const candidateCookies = verifiedExtensionGrant
              ? (verifiedExtensionGrant.allowedDomains && verifiedExtensionGrant.allowedDomains.length > 0
                  ? rawCookies.filter((c: ExtensionCookieInput) => {
                      const domain = c.domain ? (c.domain.startsWith('.') ? c.domain.slice(1) : c.domain) : '';
                      return verifiedExtensionGrant.allowedDomains.some(rawAllowed => {
                        const allowed = rawAllowed.startsWith('.') ? rawAllowed.slice(1) : rawAllowed;
                        return domain === allowed || domain.endsWith('.' + allowed);
                      });
                    })
                  : [])
              : rawCookies;
            for (const cookie of candidateCookies) {
              const setDetails = extensionCookieImportSetDetails(cookie, { persistSessionCookies: persistSession });
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
            try {
              await targetSession.cookies.flushStore();
            } catch {}

            res.writeHead(200, responseHeaders);
            res.end(JSON.stringify({
              success: true,
              importedCount,
              removedCount: 0,
              skippedCount,
              failedCount,
              totalReceived: rawCookies.length,
              targetTabId: resolvedTargetTabId ?? (data.tabId || this.tabHost.getActiveTab()?.id || null),
              targetPartition: requestedPartition || (resolvedTargetTabId ? `tab:${resolvedTargetTabId}` : 'activeTab'),
            }));
          } catch (err: unknown) {
            res.writeHead(400, responseHeaders);
            res.end(JSON.stringify({ success: false, error: 'INVALID_JSON_BODY', message: err instanceof Error ? err.message : String(err) }));
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

      this.wss = new WebSocketServer({
        server: this.httpServer,
        handleProtocols: (protocols: Set<string>) => {
          if (protocols.has('antifan-auth')) return 'antifan-auth';
          if (protocols.has('antifan')) return 'antifan';
          return false;
        },
      });
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
          this.wss = new WebSocketServer({
            server: altServer,
            handleProtocols: (protocols: Set<string>) => {
              if (protocols.has('antifan-auth')) return 'antifan-auth';
              if (protocols.has('antifan')) return 'antifan';
              return false;
            },
          });
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
      const url = new URL(req.url || '/', `http://localhost`);
      const host = req.headers.host || `127.0.0.1:${this.port}`;
      // 1. Strict Query Parameter Prohibition on WebSockets
      if (url.searchParams.has('token') || url.searchParams.has('secret') || url.searchParams.has('code') || (url.search && /token=|secret=|code=/i.test(url.search))) {
        ws.close(4001, 'Unauthorized: SECRETS_IN_URL_FORBIDDEN - Tokens in URL query string are strictly prohibited');
        return;
      }

      // Loopback-by-default boundary enforcement
      const remoteIp = req.socket.remoteAddress || '';
      const isLoopback = remoteIp === '127.0.0.1' || remoteIp === '::1' || remoteIp === '::ffff:127.0.0.1';
      if (!this.lanOptIn && !isLoopback) {
        ws.close(4003, 'Forbidden: LAN access disabled');
        return;
      }

      // Token authentication: Authorization: Bearer, X-Antifan-Attachment-Secret, Sec-WebSocket-Protocol, or cookie
      const clientToken = extractAuthToken(req);
      const isBridgeToken = Boolean(clientToken && clientToken === this.token);
      const verifiedAttachmentId = clientToken ? (this.attachmentRegistry?.verifyConnectionToken(clientToken) ?? null) : null;
      const verifiedMobileGrant = clientToken ? this.getMobileGrant(clientToken) : null;
      if (!isBridgeToken && !verifiedAttachmentId && !verifiedMobileGrant) {
        ws.close(4001, 'Unauthorized: missing or invalid token');
        return;
      }

      if (isBridgeToken) {
        this.socketBridgeTokens.add(ws);
      }
      if (verifiedAttachmentId && !isBridgeToken) {
        this.socketAttachmentIds.set(ws, verifiedAttachmentId);
      }
      if (verifiedMobileGrant) {
        this.socketMobileGrantIds.set(ws, verifiedMobileGrant.sessionId);
        this.socketMobileGrants.set(ws, verifiedMobileGrant);
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
      let initTabs: AntiFanTab[] = [];
      let initActiveTabId: string | undefined = undefined;
      let initTerminalSessions: SessionSummary[] = [];
      let initActiveTerminalSessionId: string | undefined = undefined;

      if (verifiedAttachmentId && !isBridgeToken) {
        // Dual-Plane Rule: Agent plane attachments only see their owned tab and terminal session
        const registry = this.attachmentRegistry || this.controlPlaneRuntime?.runs?.attachments;
        const record = registry ? registry.getRecord(verifiedAttachmentId) : undefined;
        const boundTabId = record?.tabId || record?.browserTarget?.tabId;
        if (boundTabId && this.hostTabExists(boundTabId)) {
          initActiveTabId = boundTabId;
          const canonical = typeof this.tabHost.resolveTargetTabId === 'function'
            ? this.tabHost.resolveTargetTabId(boundTabId)
            : boundTabId;
          const wc = typeof this.tabHost.getTabWebContents === 'function' ? this.tabHost.getTabWebContents(boundTabId) : null;
          initTabs = [{
            id: canonical || boundTabId,
            url: wc && !wc.isDestroyed() ? wc.getURL() : 'about:blank',
            title: wc && !wc.isDestroyed() ? wc.getTitle() : 'Agent Tab',
            ephemeral: true,
          } as AntiFanTab];
          if (typeof this.tabHost.isTerminalAllowedForTab === 'function') {
            initTerminalSessions = tm.listSessions().filter(s => this.tabHost.isTerminalAllowedForTab(boundTabId, s.id));
            const ownedSessionId = typeof this.tabHost.getTabTerminalSession === 'function'
              ? this.tabHost.getTabTerminalSession(boundTabId)
              : undefined;
            initActiveTerminalSessionId = ownedSessionId || initTerminalSessions[0]?.id;
          }
        }
      } else if (verifiedMobileGrant) {
        // Mobile companion: trim according to allowedScopes and user plane isolation
        if (verifiedMobileGrant.allowedScopes.includes('tabs.view')) {
          initTabs = this.tabHost.getTabList();
          initActiveTabId = this.tabHost.getActiveTabId();
        }
        if (verifiedMobileGrant.allowedScopes.includes('terminal.sync')) {
          initTerminalSessions = tm.listSessions().filter(s => {
            if (typeof this.tabHost.getTerminalAgentAffinity === 'function') {
              const aff = this.tabHost.getTerminalAgentAffinity(s.id);
              return !aff || aff.status !== 'alive';
            }
            return true;
          });
          const activeId = tm.getActiveSessionId();
          initActiveTerminalSessionId = initTerminalSessions.some(s => s.id === activeId)
            ? activeId
            : initTerminalSessions[0]?.id;
        }
      } else {
        // User plane Bridge client (IDE companion): only user-plane tabs and user-plane terminals
        initTabs = this.tabHost.getTabList();
        initActiveTabId = this.tabHost.getActiveTabId();
        initTerminalSessions = tm.listSessions().filter(s => {
          if (typeof this.tabHost.getTerminalAgentAffinity === 'function') {
            const aff = this.tabHost.getTerminalAgentAffinity(s.id);
            return !aff || aff.status !== 'alive';
          }
          return true;
        });
        const activeId = tm.getActiveSessionId();
        initActiveTerminalSessionId = initTerminalSessions.some(s => s.id === activeId)
          ? activeId
          : initTerminalSessions[0]?.id;
      }

      this.sendEvent(ws, 'antifan:init', {
        status: this.getStatus(),
        tabs: initTabs,
        activeTabId: initActiveTabId,
        terminalSessions: initTerminalSessions,
        activeTerminalSessionId: initActiveTerminalSessionId,
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
      protocolVersion: 1,
      endpoints: {
        pairingExchange: '/api/pairing/exchange',
        pairingChallenge: '/api/pairing/challenge',
        status: '/status',
        mobile: '/mobile',
        ws: '/',
      },
    };
    try {
      this.atomicWriteWithDacl(this.bridgeInfoPath, JSON.stringify(info, null, 2));
      console.log(`[antifan] Persisted non-secret bridge info to ${this.bridgeInfoPath}`);

      const geminiDir = path.join(os.homedir(), '.gemini');
      if (fs.existsSync(geminiDir)) {
        const geminiFileName = this.isDev ? 'antifan_bridge_dev.json' : 'antifan_bridge.json';
        this.atomicWriteWithDacl(path.join(geminiDir, geminiFileName), JSON.stringify(info, null, 2));
      }
    } catch (err) {
      console.error('[antifan] Failed to persist bridge info:', err);
    }
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
      const sanitizedError = error ? redactCredentials(error) : undefined;
      const resp: BridgeResponsePayload = { id, success, data, error: sanitizedError };
      if (ws.readyState === WebSocket.OPEN) {
        ws.send(JSON.stringify(resp));
      }
    };

    try {
      const boundAttachmentId = this.socketAttachmentIds.get(ws);
      if (
        boundAttachmentId &&
        method !== 'antifan.capability.dispatch' &&
        method !== 'antifan.cli.renewSession' &&
        method !== 'antifan.cli.heartbeat'
      ) {
        respond(false, undefined, 'Forbidden: Attachment-authenticated connections may only invoke antifan.capability.dispatch or renewSession');
        return;
      }
      if (method !== 'antifan.capability.dispatch' && this.capabilityTransport && typeof p.runtimeLease === 'object') {
        respond(false, undefined, 'UNAUTHENTICATED: Direct capability dispatch without attachment claims is forbidden. Use antifan.capability.dispatch.');
        return;
      }
      const mobileGrant = this.socketMobileGrants.get(ws);
      if (mobileGrant) {
        const cleanMethod = method.startsWith('antifan.') ? method.slice(8) : method;
        let requiredScope: string | undefined;

        if (cleanMethod === 'getTabs') {
          requiredScope = 'tabs.view';
        } else if (
          cleanMethod === 'getTerminalSessions' ||
          cleanMethod === 'terminalListSessions' ||
          cleanMethod === 'terminalSwitchSession'
        ) {
          requiredScope = 'terminal.sync';
        } else if (
          cleanMethod === 'terminalInput' ||
          cleanMethod === 'terminalSendKey' ||
          cleanMethod === 'terminalResize' ||
          cleanMethod === 'terminalNewSession' ||
          cleanMethod === 'terminalCloseSession' ||
          cleanMethod === 'terminalRenameSession' ||
          cleanMethod === 'terminalRestart'
        ) {
          requiredScope = 'terminal.input';
        } else if (cleanMethod === 'getStatus' || cleanMethod === 'getLanIps') {
          requiredScope = undefined;
        } else {
          respond(false, undefined, `FORBIDDEN: Method '${method}' is not permitted for mobile grants`);
          return;
        }

        if (requiredScope && !mobileGrant.allowedScopes.includes(requiredScope)) {
          respond(false, undefined, `FORBIDDEN: Scope '${requiredScope}' required for method '${method}'`);
          return;
        }

        // Prevent mobile client from operating on agent-owned terminal sessions
        const targetSessionId = typeof p.sessionId === 'string' ? p.sessionId : (typeof p.id === 'string' ? p.id : undefined);
        const effectiveTerminalId = targetSessionId || (cleanMethod.startsWith('terminal') ? TerminalManager.getInstance().getActiveSessionId() : undefined);
        if (effectiveTerminalId && typeof this.tabHost.getTerminalAgentAffinity === 'function') {
          const aff = this.tabHost.getTerminalAgentAffinity(effectiveTerminalId);
          if (aff && aff.status === 'alive') {
            respond(false, { code: 'TERMINAL_FORBIDDEN', message: 'Access to agent-owned terminal is forbidden' }, 'TERMINAL_FORBIDDEN: Access to agent-owned terminal is forbidden');
            return;
          }
        }
      }

      switch (method) {
        case 'antifan.capability.dispatch': {
          if (!this.capabilityTransport) {
            respond(false, undefined, 'Capability transport is not available');
            break;
          }
          try {
            const claims = p.attachmentClaims;
            const targetAttachmentId = String(p.attachmentId || claims?.attachmentId || boundAttachmentId || '');
            if (boundAttachmentId && targetAttachmentId && targetAttachmentId !== boundAttachmentId) {
              respond(false, undefined, 'ATTACHMENT_INVALID: Cross-attachment dispatch denied: connection is bound to a different attachment');
              break;
            }
            const attachmentId = targetAttachmentId;
            const attachmentSecret = String(p.attachmentSecret || claims?.attachmentSecret || claims?.secret || '');
            const authorityRevision = String(p.authorityRevision || claims?.authorityRevision || claims?.revision || '');

            const intent: ClientInvocationIntent = {
              requestId: p.requestId || (typeof id === 'string' ? id : makeControlPlaneId('request')),
              idempotencyKey: p.idempotencyKey || p.invocationId || claims?.invocationId || makeControlPlaneId('idempotency'),
              attachmentId,
              attachmentSecret,
              authorityRevision,
              name: p.name,
              params: p.params || {},
            };
            const dispatchResult = await this.capabilityTransport.dispatchIntent(intent);
            if (dispatchResult.ok) {
              respond(true, {
                data: dispatchResult.data,
                requestId: dispatchResult.requestId,
                invocationId: dispatchResult.invocationId,
                replacementAuthorityRevision: dispatchResult.replacementAuthorityRevision,
                authorityRevision: dispatchResult.replacementAuthorityRevision,
              });
            } else {
              const code = dispatchResult.error?.code || 'CAPABILITY_ERROR';
              const message = dispatchResult.error?.message || 'Capability dispatch failed';
              respond(false, {
                code,
                message,
                details: dispatchResult.error?.details,
                replacementAuthorityRevision: dispatchResult.replacementAuthorityRevision,
                authorityRevision: dispatchResult.replacementAuthorityRevision,
              }, `${code}: ${message}`);
            }
          } catch (err: unknown) {
            const code = err instanceof CapabilityError ? err.code : 'CAPABILITY_ERROR';
            const message = err instanceof Error ? err.message : String(err);
            const details = err instanceof CapabilityError ? err.details : undefined;
            respond(false, { code, message, details }, `${code}: ${message}`);
          }
          break;
        }
        case 'antifan.cli.startSession': {
          if (!this.controlPlaneRuntime) {
            respond(false, undefined, 'Control plane runtime is not available');
            break;
          }
          try {
            let tabId = typeof p.tabId === 'string' && p.tabId.trim() ? p.tabId.trim() : undefined;
            if (tabId) {
              const canonical = typeof this.tabHost.resolveTargetTabId === 'function'
                ? this.tabHost.resolveTargetTabId(tabId)
                : undefined;
              const effective = canonical ?? tabId;
              if (!this.hostTabExists(effective)) {
                throw new Error(`TAB_NOT_FOUND: The specified tabId '${tabId}' does not exist or was closed.`);
              }
              tabId = effective;
            } else {
              const terminalSessionId = typeof p.terminalSessionId === 'string' && p.terminalSessionId.trim() ? p.terminalSessionId.trim() : undefined;
              const terminalGen = typeof p.terminalGeneration === 'string' || typeof p.terminalGeneration === 'number' ? p.terminalGeneration : undefined;
              if (terminalSessionId) {
                if (typeof this.tabHost.getTerminalAgentAffinity === 'function') {
                  const affinity = this.tabHost.getTerminalAgentAffinity(terminalSessionId, terminalGen);
                  if (affinity) {
                    if (affinity.status === 'alive' && this.hostTabExists(affinity.tabId)) {
                      tabId = affinity.tabId;
                    } else {
                      const closedNotice = affinity.lastUrl ? `(${affinity.lastUrl})` : `(${affinity.tabId})`;
                      throw new Error(`TERMINAL_TAB_CLOSED: The tab previously attached to this terminal ${closedNotice} was closed. Please rebind or specify a tabId.`);
                    }
                  }
                }
                if (!tabId) {
                  const currentAutoTab = typeof this.tabHost.getAutomationTabId === 'function' ? this.tabHost.getAutomationTabId() : undefined;
                  if (currentAutoTab && this.hostTabExists(currentAutoTab)) {
                    const isOffscreen = typeof this.tabHost.isTabOffscreen === 'function' && this.tabHost.isTabOffscreen(currentAutoTab);
                    const tabList = typeof this.tabHost.getTabList === 'function' ? this.tabHost.getTabList() : [];
                    const tabRecord = tabList.find((t) => t && t.id === currentAutoTab);
                    const isAgentOffscreenOrEphemeral = Boolean(isOffscreen || tabRecord?.offscreen || tabRecord?.ephemeral);

                    const targetAttachmentId = typeof p.attachmentId === 'string' && p.attachmentId.trim() ? p.attachmentId.trim() : boundAttachmentId;
                    const registry = this.attachmentRegistry || this.controlPlaneRuntime?.runs?.attachments;
                    const attachmentRecord = targetAttachmentId && registry ? registry.getRecord(targetAttachmentId) : undefined;
                    const belongsToThisAttachment = Boolean(
                      attachmentRecord && (attachmentRecord.tabId === currentAutoTab || attachmentRecord.browserTarget?.tabId === currentAutoTab)
                    );

                    if (isAgentOffscreenOrEphemeral && belongsToThisAttachment) {
                      tabId = currentAutoTab;
                      if (typeof this.tabHost.bindTerminalAgentAffinity === 'function') {
                        this.tabHost.bindTerminalAgentAffinity(terminalSessionId, terminalGen, currentAutoTab);
                      }
                    }
                  }
                }
                if (!tabId) {
                  tabId = this.tabHost.createTab('about:blank', false, { offscreen: true, ephemeral: true });
                  if (typeof this.tabHost.bindTerminalAgentAffinity === 'function') {
                    this.tabHost.bindTerminalAgentAffinity(terminalSessionId, terminalGen, tabId);
                  }
                }
              } else {
                // Phase 2 (steps 2/3): reuse ONLY the authorized browser target this
                // exact attachment already owns (attachment-record browserTarget).
                // NEVER fall back to another session's global automation target
                // (previous reuse of getAutomationTabId() made session B latch onto
                // session A's tab, clobbering the bound invocation). If there is no
                // owned live tab, provision a dedicated offscreen/ephemeral agent tab
                // immediately (never inspect activeTabId / foreground).
                const targetAttachmentId = typeof p.attachmentId === 'string' && p.attachmentId.trim() ? p.attachmentId.trim() : boundAttachmentId;
                const registry = this.attachmentRegistry || this.controlPlaneRuntime?.runs?.attachments;
                const attachmentRecord = targetAttachmentId && registry ? registry.getRecord(targetAttachmentId) : undefined;
                const ownTabId = attachmentRecord?.tabId || attachmentRecord?.browserTarget?.tabId;
                if (ownTabId && this.hostTabExists(ownTabId)) {
                  tabId = ownTabId;
                } else {
                  tabId = this.tabHost.createTab('about:blank', false, { offscreen: true, ephemeral: true });
                }
              }
            }
            // Phase 2: intentionally no `setAutomationTabId(tabId)` here. Each
            // attachment's binding lives in its own authority record; writing the
            // session's tab onto the process-global automation target would let one
            // session clobber another's bound invocation.
            const ownerPid = typeof p.ownerPid === 'number' && p.ownerPid > 0 ? p.ownerPid : undefined;
            const res = await this.controlPlaneRuntime.createCliSession({
              projectId: typeof p.projectId === 'string' ? p.projectId : undefined,
              workspaceId: typeof p.workspaceId === 'string' ? p.workspaceId : undefined,
              cwd: typeof p.cwd === 'string' ? p.cwd : undefined,
              backendId: p.backendId || 'cli',
              grant: p.grant || 'eval',
              tabId,
              browserEpoch: p.browserEpoch,
              ttlMs: typeof p.ttlMs === 'number' ? Math.min(Math.max(p.ttlMs, 10_000), 86_400_000) : 7_200_000,
              ownerPid,
            });
            // Master-token sockets retain full authority and may mint multiple CLI
            // sessions; only non-master sockets (attachment/mobile-authenticated) get
            // scoped to the single freshly-minted attachment for subsequent dispatch.
            if (!this.socketBridgeTokens.has(ws)) {
              this.socketAttachmentIds.set(ws, res.launch.attachmentId);
            }
            respond(true, {
              runId: res.run.id,
              attemptId: res.attempt.id,
              attachmentId: res.launch.attachmentId,
              secret: res.launch.secret,
              projectId: res.launch.projectId,
              workspaceId: res.launch.workspaceId,
              tabId: res.launch.tabId || tabId,
              authorityRevision: res.launch.authorityRevision,
              host: this.host,
              port: this.port,
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
            const res = await this.controlPlaneRuntime.endCliSession(
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
          if (boundAttachmentId && attachmentId !== boundAttachmentId) {
            respond(false, undefined, 'ATTACHMENT_INVALID: Cross-attachment renew denied: connection is bound to a different attachment');
            break;
          }
          try {
            const extensionMs = typeof p.extensionMs === 'number' && p.extensionMs > 0 ? p.extensionMs : undefined;
            const ownerPid = typeof p.ownerPid === 'number' ? p.ownerPid : undefined;
            const res = await this.controlPlaneRuntime.renewCliSession(attachmentId, secret, { extensionMs, ownerPid });
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
          const isAgentCaller = Boolean(boundAttachmentId || p.attachmentId);
          if (isAgentCaller && p.activate === true) {
            respond(false, { code: 'USER_VISIBLE_OPERATION_FORBIDDEN', message: 'Agent plane cannot activate or focus tabs in foreground' }, 'USER_VISIBLE_OPERATION_FORBIDDEN: Agent plane cannot activate or focus tabs in foreground');
            break;
          }
          const activate = Boolean(p.activate ?? false);
          const isEphemeral = isAgentCaller ? (p.ephemeral !== false && p.userFacing !== true) : Boolean(p.ephemeral);
          // Phase 2 (step 11): agent-created tabs are dedicated offscreen surfaces so
          // capture never foregrounds/attaches the user's visible view. Forward the
          // offscreen option through the adapter; default offscreen for agent callers.
          const isOffscreen = isAgentCaller ? (p.offscreen !== false && p.userFacing !== true) : Boolean(p.offscreen);
          const tabId = this.tabHost.createTab(p.url, activate, { ephemeral: isEphemeral, offscreen: isOffscreen });
          respond(true, { tabId });
          break;
        }

        case 'switchTab':
        case 'antifan.switchTab': {
          const isAgentCaller = Boolean(boundAttachmentId || p.attachmentId);
          if (isAgentCaller) {
            respond(false, { code: 'USER_VISIBLE_OPERATION_FORBIDDEN', message: 'Agent-plane callers cannot activate or switch user-visible tabs' }, 'USER_VISIBLE_OPERATION_FORBIDDEN: Agent-plane callers cannot activate or switch user-visible tabs');
            break;
          }
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
          const target = this.resolveDirectRpcTargetTab(p.tabId, boundAttachmentId, p.attachmentId);
          if ('error' in target) {
            respond(false, undefined, target.error);
            break;
          }
          const ok = this.tabHost.navigate(target.tabId, p.url);
          respond(ok, { navigated: ok });
          break;
        }

        case 'reload':
        case 'antifan.reload': {
          const target = this.resolveDirectRpcTargetTab(p.tabId, boundAttachmentId, p.attachmentId);
          if ('error' in target) {
            respond(false, undefined, target.error);
            break;
          }
          const ok = this.tabHost.reload(target.tabId);
          respond(ok, { reloaded: ok });
          break;
        }

        case 'goBack':
        case 'antifan.goBack': {
          const target = this.resolveDirectRpcTargetTab(p.tabId, boundAttachmentId, p.attachmentId);
          if ('error' in target) {
            respond(false, undefined, target.error);
            break;
          }
          const ok = this.tabHost.goBack(target.tabId);
          respond(ok, { wentBack: ok });
          break;
        }

        case 'goForward':
        case 'antifan.goForward': {
          const target = this.resolveDirectRpcTargetTab(p.tabId, boundAttachmentId, p.attachmentId);
          if ('error' in target) {
            respond(false, undefined, target.error);
            break;
          }
          const ok = this.tabHost.goForward(target.tabId);
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
              // Phase 2 (step 6): an attachment-bound caller may only write to a
              // terminal it owns. Enforced below via auto-owned resolution.
              const verified = this.terminalWriteForAttachment(p.sessionId, boundAttachmentId, p.attachmentId);
              if (!verified) {
                respond(false, undefined, 'TERMINAL_FORBIDDEN: attachment does not own the target terminal session');
                break;
              }
              tm.writeTo(p.sessionId, p.text);
            } else if (boundAttachmentId) {
              // Attachment callers must never fall back to the user's active shell.
              // Reject with TERMINAL_FORBIDDEN unless a sessionId is required.
              respond(false, undefined, 'TERMINAL_FORBIDDEN: terminalSessionId is required for attachment input');
              break;
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
              const verified = this.terminalWriteForAttachment(p.sessionId, boundAttachmentId, p.attachmentId);
              if (!verified) {
                respond(false, undefined, 'TERMINAL_FORBIDDEN: attachment does not own the target terminal session');
                break;
              }
              tm.writeTo(p.sessionId, sequence);
            } else if (boundAttachmentId) {
              respond(false, undefined, 'TERMINAL_FORBIDDEN: terminalSessionId is required for attachment key input');
              break;
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
          if (boundAttachmentId) {
            if (typeof p.sessionId !== 'string' || !p.sessionId.trim()) {
              respond(false, undefined, 'TERMINAL_FORBIDDEN: terminalSessionId is required for attachment close');
              break;
            }
            const verified = this.terminalWriteForAttachment(p.sessionId, boundAttachmentId, p.attachmentId);
            if (!verified) {
              respond(false, undefined, 'TERMINAL_FORBIDDEN: attachment does not own the target terminal session');
              break;
            }
          }
          const targetId = p.sessionId || tm.getActiveSessionId();
          const closed = await tm.closeSession(targetId);
          respond(closed, { closed, sessions: tm.listSessions(), activeSessionId: tm.getActiveSessionId() });
          break;
        }

        case 'terminalRenameSession':
        case 'antifan.terminalRenameSession': {
          const tm = TerminalManager.getInstance();
          if (boundAttachmentId) {
            if (typeof p.sessionId !== 'string' || !p.sessionId.trim()) {
              respond(false, undefined, 'TERMINAL_FORBIDDEN: terminalSessionId is required for attachment rename');
              break;
            }
            const verified = this.terminalWriteForAttachment(p.sessionId, boundAttachmentId, p.attachmentId);
            if (!verified) {
              respond(false, undefined, 'TERMINAL_FORBIDDEN: attachment does not own the target terminal session');
              break;
            }
          }
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
        case 'reloadScripts':
        case 'antifan.system.reloadScripts': {
          if (!this.isDev) {
            respond(false, undefined, 'FORBIDDEN: Soft reload is only permitted in development mode');
            break;
          }
          if (boundAttachmentId) {
            respond(false, undefined, 'FORBIDDEN: Attachment-bound connections cannot invoke administrative soft-reload');
            break;
          }
          const scriptId = typeof p?.scriptId === 'string' && p.scriptId.trim() ? p.scriptId.trim() : undefined;
          injectedScriptStore.clearOverrides(scriptId);
          const scripts = injectedScriptStore.listScripts();
          respond(true, {
            reloaded: true,
            scriptCount: scripts.length,
            scripts,
          });
          break;
        }

        case 'reloadUi':
        case 'antifan.system.reloadUi': {
          if (!this.isDev) {
            respond(false, undefined, 'FORBIDDEN: UI reload is only permitted in development mode');
            break;
          }
          if (boundAttachmentId) {
            respond(false, undefined, 'FORBIDDEN: Attachment-bound connections cannot invoke administrative UI reload');
            break;
          }
          this.tabHost.reloadWindow();
          respond(true, { reloaded: true, surfaces: ['toolbar', 'sidebar', 'terminal-windows'] });
          break;
        }

        case 'getScriptStatus':
        case 'antifan.system.getScriptStatus': {
          respond(true, {
            isDev: this.isDev,
            scripts: injectedScriptStore.listScripts(),
          });
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
  /**
   * Phase 2 (step 6): verifies a terminal session belongs to the calling attachment
   * (via its owned browser tab's terminal affinity). Attachment-bound callers may only
   * operate terminals they own; no fallback to the user's active shell.
   */
  private terminalWriteForAttachment(sessionId: string, boundAttachmentId?: string, attachmentIdParam?: unknown): boolean {
    if (!sessionId) return false;
    const targetAttachmentId = boundAttachmentId || (typeof attachmentIdParam === 'string' && attachmentIdParam.trim() ? attachmentIdParam.trim() : undefined);
    if (!targetAttachmentId) return false;
    const registry = this.attachmentRegistry || this.controlPlaneRuntime?.runs?.attachments;
    const attachmentRecord = registry ? registry.getRecord(targetAttachmentId) : undefined;
    const ownedTabId = attachmentRecord?.tabId || attachmentRecord?.browserTarget?.tabId;
    if (!ownedTabId || typeof this.tabHost.getTabTerminalSession !== 'function') return false;
    const ownedTerminalIds = this.tabHost.getTabTerminalSession(ownedTabId);
    const ownedList = (Array.isArray(ownedTerminalIds) ? ownedTerminalIds : [ownedTerminalIds]).filter(Boolean);
    return ownedList.includes(sessionId);
  }

  private resolveDirectRpcTargetTab(
    tabIdParam?: unknown,
    boundAttachmentId?: string,
    attachmentIdParam?: unknown
  ): { tabId: string } | { error: string; code: 'TARGET_REQUIRED' | 'TARGET_CLOSED' } {
    const targetAttachmentId = boundAttachmentId || (typeof attachmentIdParam === 'string' && attachmentIdParam.trim() ? attachmentIdParam.trim() : undefined);
    const registry = this.attachmentRegistry || this.controlPlaneRuntime?.runs?.attachments;
    const attachmentRecord = targetAttachmentId && registry ? registry.getRecord(targetAttachmentId) : undefined;
    const boundTabId = attachmentRecord?.tabId || attachmentRecord?.browserTarget?.tabId;
    const candidateTabId = typeof tabIdParam === 'string' && tabIdParam.trim() ? tabIdParam.trim() : boundTabId;
    if (!candidateTabId) {
      return { code: 'TARGET_REQUIRED', error: 'TARGET_REQUIRED: Target tabId is required' };
    }
    const canonical = typeof this.tabHost.resolveTargetTabId === 'function'
      ? this.tabHost.resolveTargetTabId(candidateTabId)
      : undefined;
    const effective = canonical ?? candidateTabId;
    if (!this.hostTabExists(effective)) {
      return { code: 'TARGET_CLOSED', error: `TARGET_CLOSED: Target tab '${candidateTabId}' not found or destroyed` };
    }
    return { tabId: effective };
  }

  /** Defensive tab-existence check: hasTab is an optional host capability.
   *  When the host cannot verify (no hasTab), treat as existing so an
   *  unverifiable target never crashes the bridge — the op still fails closed
   *  at the authority/resolution layer if the tab is truly unknown. */
  private hostTabExists(tabId?: string | null): boolean {
    if (!tabId) return false;
    if (typeof this.tabHost.hasTab === 'function') return this.tabHost.hasTab(tabId);
    const list = typeof this.tabHost.getTabList === 'function' ? this.tabHost.getTabList() : [];
    if (Array.isArray(list)) {
      return list.some((tab: unknown) => tab && typeof tab === 'object' && (tab as { id?: unknown }).id === tabId);
    }
    return true;
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
      this.pruneExpiredGrants();
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

  private isClientAuthorizedForTerminal(client: WebSocket, terminalSessionId?: string): boolean {
    if (!terminalSessionId) return false;

    // 1. Agent plane attachment: must have affinity with the attachment's bound tab
    const boundAttachmentId = this.socketAttachmentIds.get(client);
    if (boundAttachmentId) {
      const registry = this.attachmentRegistry || this.controlPlaneRuntime?.runs?.attachments;
      const record = registry ? registry.getRecord(boundAttachmentId) : undefined;
      const boundTabId = record?.tabId || record?.browserTarget?.tabId;
      if (!boundTabId) return false;
      if (typeof this.tabHost.isTerminalAllowedForTab === 'function') {
        return this.tabHost.isTerminalAllowedForTab(boundTabId, terminalSessionId);
      }
      return false;
    }

    // 2. Mobile companion client: requires terminal.sync scope and MUST NOT be an agent-owned terminal
    const mobileGrant = this.socketMobileGrants.get(client);
    if (mobileGrant) {
      if (!mobileGrant.allowedScopes.includes('terminal.sync')) return false;
      if (typeof this.tabHost.getTerminalAgentAffinity === 'function') {
        const aff = this.tabHost.getTerminalAgentAffinity(terminalSessionId);
        if (aff && aff.status === 'alive') return false; // Agent terminal isolated from mobile
      }
      return true;
    }

    // 3. User plane Bridge client: isolated from agent-plane terminals
    if (typeof this.tabHost.getTerminalAgentAffinity === 'function') {
      const aff = this.tabHost.getTerminalAgentAffinity(terminalSessionId);
      if (aff && aff.status === 'alive') return false; // Agent terminal isolated from user plane
    }
    return true;
  }

  public broadcastEvent(event: string, data: unknown): void {
    const payload: BridgeEventPayload = { event, data };
    const broadcastStartMs = performance.now();
    const isTerminalData = event === 'antifan:terminal:data';
    const isTerminalSession = event === 'antifan:terminal:session';
    let terminalSessionId: string | undefined;
    if (isTerminalData && data && typeof data === 'object' && 'sessionId' in data) {
      terminalSessionId = String(data.sessionId ?? '');
    } else if (isTerminalSession && data && typeof data === 'object' && 'id' in data) {
      terminalSessionId = String(data.id ?? '');
    }
    let sent = 0;
    let congested = 0;
    for (const client of this.clients) {
      if (client.readyState !== WebSocket.OPEN) continue;
      const boundAttachmentId = this.socketAttachmentIds.get(client);
      const mobileGrant = this.socketMobileGrants.get(client);

      // Dual-plane isolation for events
      if (isTerminalData) {
        if (!this.isClientAuthorizedForTerminal(client, terminalSessionId)) {
          continue;
        }
      } else if (isTerminalSession) {
        if (boundAttachmentId) {
          // Agent plane attachments do not receive ambient session lifecycle broadcasts
          continue;
        }
        if (mobileGrant && !mobileGrant.allowedScopes.includes('terminal.sync')) {
          continue;
        }
      } else if (event === 'antifan:tabChanged') {
        if (boundAttachmentId) {
          // Agent plane attachments are isolated from user-plane tab changes
          continue;
        }
        if (mobileGrant && !mobileGrant.allowedScopes.includes('tabs.view')) {
          continue;
        }
      }

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

    try {
      if (fs.existsSync(this.pairingQueueDir)) {
        const files = fs.readdirSync(this.pairingQueueDir);
        for (const file of files) {
          try {
            fs.unlinkSync(path.join(this.pairingQueueDir, file));
          } catch {}
        }
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

function extractAuthToken(req: http.IncomingMessage): string | null {
  const authHeader = req.headers['authorization'];
  if (authHeader && typeof authHeader === 'string') {
    const match = authHeader.match(/^Bearer\s+(.+)$/i);
    if (match && match[1]) return match[1].trim();
  }

  const customHeader = req.headers['x-antifan-attachment-secret'];
  if (customHeader && typeof customHeader === 'string') {
    return customHeader.trim();
  }

  const cookieHeader = req.headers['cookie'];
  if (cookieHeader && typeof cookieHeader === 'string') {
    const match = cookieHeader.match(/(?:^|;\s*)antifan_mobile_token=([^;]+)/);
    if (match && match[1]) return decodeURIComponent(match[1].trim());
    const matchSecret = cookieHeader.match(/(?:^|;\s*)antifan_attachment_secret=([^;]+)/);
    if (matchSecret && matchSecret[1]) return decodeURIComponent(matchSecret[1].trim());
  }

  const secWsProtocol = req.headers['sec-websocket-protocol'];
  if (secWsProtocol && typeof secWsProtocol === 'string') {
    const parts = secWsProtocol.split(',').map(s => s.trim());
    const tokenPart = parts.find(p => p !== 'antifan-auth' && p !== 'antifan');
    if (tokenPart) return tokenPart;
  }

  return null;
}
