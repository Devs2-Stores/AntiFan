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
import { TerminalManager, DEFAULT_TERMINAL_CAPSULE_ID, agentTerminalOwnerKey, type SessionSummary } from '../browser/terminal-manager';
import { parseOwnerKey } from '../project/project-context';
import { renderMobileRemoteHtml } from './mobile-remote-html';
import { generateQrSvg } from './qr-generator';
import {
  AntiFanBridgeStatus,
  BridgeRequestPayload,
  BridgeResponsePayload,
  BridgeEventPayload,
  AntiFanPickedElement,
  AntiFanTab,
  BridgeFailureRecord,
  BridgeHealthState,
} from '../../shared/contracts';
import {
  BRIDGE_FAILURE_RECENCY_MS,
  BRIDGE_HEALTH_HEARTBEAT_MS,
  emitBridgeHealthChanged,
} from './bridge-health';
import { CapabilityTransportAdapter } from '../tools/capability-transport';
import { CapabilityRequestContext, CapabilityError, BrowserTarget, RuntimeLease, ArtifactRef, ClientInvocationIntent, makeControlPlaneId, hashSecret, verifySecret } from '../../shared/control-plane-contracts';
import { AttachmentRegistry, type PageCloseAdmission } from '../run/attachment-registry';
import { SessionCapabilityFilter, isCapabilityNamePermitted } from '../tools/capability-catalogue';
import { enforceProtectedDirectoryDacl, enforceProtectedFileDacl, resolveCurrentUserSid, applyProtectedPathsDacl } from '../security/windows-acl';
import { ControlPlaneRuntime } from '../control-plane/control-plane-runtime';
import { deriveCapsulePartition } from '../browser/browser-session-partition';
import { extensionCookieImportSetDetails, type ExtensionCookieInput } from '../browser/chrome-profile-sync';
import { isIdentityCookieName } from '../../shared/identity-cookie-patterns';
import { injectedScriptStore } from '../browser/scripts/injected-script-store.js';
export const OFFICIAL_COMPANION_EXTENSION_ID = 'khjcaadjohoclofjkkfblkbfbpmjjedp';

/**
 * Least-privilege receiver allowlist for companion-extension cookie import.
 *
 * This is the receiver boundary: a cookie whose domain is not covered here is
 * dropped before it reaches the Electron jar, even when the companion extension
 * was explicitly scoped to send it. It must therefore cover every profile the
 * extension can extract (`SCOPE_PROFILES` in `src/extension/domain-scoper.ts`),
 * or the sync silently no-ops while `/api/cookies/import` still answers 200 —
 * the exact failure that hid every Google login from AntiFan.
 *
 * Kept hand-maintained on purpose: this is a security boundary, so widening the
 * grant from the sender's declared scope must stay an explicit, reviewable
 * change rather than an automatic derivation.
 * `test/main/extension-companion-pipeline.test.ts` fails if the two lists drift.
 */
export const DEFAULT_EXTENSION_ALLOWED_DOMAINS: string[] = [
  // Extension profile `google` — accounts, YouTube, Google-served assets.
  // `accounts.google.com` is covered by the `google.com` suffix rule.
  'google.com',
  'youtube.com',
  'googleusercontent.com',
  'gstatic.com',
  'google.com.vn',
  // Extension profile `ecommerce` plus the CDN hosts those storefronts serve.
  'haravan.com',
  'myharavan.com',
  'hstatic.net',
  'sapo.vn',
  'mysapo.net',
  'mysapo.vn',
  'bizwebvietnam.net',
  'bizweb.vn',
  'dktcdn.net',
  'shopify.com',
  'myshopify.com',
  'shopifycloud.com',
];

export interface ExtensionSessionGrant {
  grantToken: string;
  targetPartitionId: string;
  capabilities: ['session.cookies.import'];
  allowedDomains: string[];
  expiresAt: number;
  revoked?: boolean;
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

export async function applyProtectedPathsDaclBridge(paths: string[]): Promise<void> {
  if (process.platform !== 'win32') return;
  if (typeof applyProtectedPathsDacl === 'function') {
    await applyProtectedPathsDacl(paths);
  } else if (typeof enforceProtectedFileDacl === 'function') {
    const sid = typeof resolveCurrentUserSid === 'function' ? await resolveCurrentUserSid() : undefined;
    for (const p of paths) {
      await enforceProtectedFileDacl(p, sid);
    }
  }
}

export async function applyProtectedFileDacl(filePath: string): Promise<void> {
  await applyProtectedPathsDaclBridge([filePath]);
}

/**
 * Windows discovery records are space-padded to this fixed size so a heartbeat
 * refresh is one same-size write at offset 0 into the already-protected file:
 * no truncation window, no new file object, no DACL re-apply. JSON.parse accepts
 * the trailing whitespace. A payload that outgrows it falls back to the full
 * DACL'd atomic write on every publish.
 */
const DISCOVERY_RECORD_BYTES = 4096;

function discoveryRecordContent(info: Record<string, unknown>): string {
  const json = JSON.stringify(info, null, 2);
  if (process.platform !== 'win32') return json;
  const bytes = Buffer.byteLength(json, 'utf8');
  return bytes < DISCOVERY_RECORD_BYTES ? json + ' '.repeat(DISCOVERY_RECORD_BYTES - bytes) : json;
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
export const BRIDGE_SOFT_HIGH_WATER = 8 * 1024 * 1024; // bytes buffered per client before coalescing engages
export const BRIDGE_QUEUE_HARD_CAP = 32 * 1024 * 1024; // per-client FIFO cap; a client that cannot drain past it is terminated
export const BRIDGE_DRAIN_INTERVAL_MS = 50; // congestion pump cadence
export const BRIDGE_COALESCE_MAX_PARTS = 64; // maximum chunks to coalesce before sealing frame
export const BRIDGE_COALESCE_MAX_BYTES = 1024 * 1024; // 1MB maximum payload before sealing frame
// A coalesced terminal:data frame is serialized as
//   {"event":"antifan:terminal:data","data":{"sessionId":<sid>,"data":<chunks>,"seq":<n>}}
// Its exact byte size is maintained incrementally instead of by re-serializing the merged payload on
// every chunk. JSON string escaping is per-character and stateless, so the escaped length of the
// concatenation is the sum of the escaped lengths of the parts: that keeps merging O(1) per chunk
// while `bytes`/`queuedBytes` stay EXACT. Exactness is load-bearing — queuedBytes gates
// BRIDGE_QUEUE_HARD_CAP and slow-client termination, so an over-estimate disconnects healthy clients.
const BRIDGE_TERMINAL_FRAME_PREFIX_BYTES = Buffer.byteLength('{"event":"antifan:terminal:data","data":{"sessionId":', 'utf8');
const BRIDGE_TERMINAL_FRAME_MID_BYTES = Buffer.byteLength(',"data":', 'utf8');
const BRIDGE_TERMINAL_FRAME_SEQ_BYTES = Buffer.byteLength(',"seq":', 'utf8');
const BRIDGE_TERMINAL_FRAME_SUFFIX_BYTES = Buffer.byteLength('}}', 'utf8');
const BRIDGE_HEARTBEAT_INTERVAL_MS = 30_000; // ping cadence; peers silent for two ticks are terminated

/**
 * Escaped byte length of `value` as a JSON string body — i.e. `JSON.stringify(value)` minus the two
 * surrounding quotes. Escaping is per-character and stateless, so this is additive across the chunks
 * that make up a coalesced payload.
 */
function escapedJsonStringBodyBytes(value: string): number {
  return Buffer.byteLength(JSON.stringify(value), 'utf8') - 2;
}

export interface PendingOutboundFrame {
  /** serialized frame text for non-coalesced events, or sealed JSON text */
  raw: string;
  /** pre-serialized Buffer frame, ready for ws.send with zero serialization on drain */
  frame: Buffer;
  /** exact serialized byte size this entry contributes to queuedBytes */
  bytes: number;
  /** non-null => terminal:data frame; consecutive frames for the same session merge until sealed */
  coalesceKey: string | null;
  sessionId?: string;
  /** unjoined data chunks; joined and serialized once upon sealing */
  dataParts?: string[];
  /** escaped byte length of the sessionId JSON field, precomputed once */
  sessionIdJsonBytes?: number;
  /** running sum of the escaped byte lengths of `dataParts` (excludes the surrounding quotes) */
  escapedDataBytes?: number;
  seq?: number;
  /** whether this frame is sealed into an immutable Buffer */
  sealed?: boolean;
  /** merged payload text; joins the pending chunks on demand so merging never concatenates */
  readonly data?: string;
}

export interface BridgeCongestionState {
  queue: PendingOutboundFrame[];
  /** index of the first unsent frame; replaces queue.shift() so dequeue is O(1) */
  head: number;
  queuedBytes: number;
  droppedFrames: number;
  droppedBytes: number;
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

/**
 * Who is asking for a status snapshot. Only an agent-plane caller names an
 * attachment: the attachment's authenticated target is that caller's answer for
 * "active", because the user's foreground tab is not its authority. User-plane
 * callers (mobile companion, IDE bridge client, an extension status probe) pass
 * nothing and read the presenting host's own state — the same host their tab list
 * comes from, so the two can never describe different windows.
 */
export interface BridgeInvocationScope {
  attachmentId?: string | null;
}

/**
 * Bridge status as one caller sees it. For an agent-plane caller with no live bound
 * target, `activeTabId` is absent and `activeTabRefusal` says why: a refusal must not
 * be readable as a window that simply has no tab.
 */
export interface BridgeStatusAnswer extends AntiFanBridgeStatus {
  activeTabRefusal?: string;
}

/**
 * What a mint routing decision is made from. `boundTabId` is the tab an operation is
 * attributed to (an attachment's browser target, or the attributed surface for tab
 * creation); `terminalSessionId` names the terminal that owns an agent session;
 * `projectId` is a validated project claim for a fresh, unbound provision.
 */
export interface BridgeMintTargetRequest {
  terminalSessionId?: string;
  projectId?: string;
  boundTabId?: string;
}

/**
 * Where an agent tab must be minted: the window that owns the terminal/tab/project
 * (never the bootstrap host by default), plus the capsule the tab is stamped with.
 * `capsuleId` absent means the mint rides the resolved window's own capsule fallback.
 * `undefined` resolution means "no owner to route by" — the bridge falls back to its
 * construction host (the unattributed, single-window behavior).
 */
export interface BridgeMintTargetResolution {
  host: NativeTabHost;
  capsuleId?: string;
}

export type BridgeMintHostResolver = (opts: BridgeMintTargetRequest) => BridgeMintTargetResolution | undefined;

export class BridgeServer {
  private static instance: BridgeServer | null = null;
  private wss: WebSocketServer | null = null;
  private httpServer: http.Server | null = null;
  private clients: Set<WebSocket> = new Set();
  private readonly socketAttachmentIds: WeakMap<WebSocket, string> = new WeakMap();
  // One stable identity per socket, minted on its first renewal: the registry releases
  // an attachment whose every renewing connection is gone, and a WeakMap lets the id
  // die with the socket it names.
  private readonly socketConnectionIds: WeakMap<WebSocket, string> = new WeakMap();
  private tabHost: NativeTabHost;
  private closeAdmission?: PageCloseAdmission;
  private pairingQueueDir: string;
  private pairingReplenishInFlight: Promise<void> | null = null;
  private isDisposed = false;
  private readonly publishesDiscovery: boolean;
  private isDev: boolean = false;
  private port: number = 20129;
  private host: string = '127.0.0.1';
  private token: string = this.resolveMasterToken();
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
  private readonly sessionCapabilityFilters: Map<string, SessionCapabilityFilter> = new Map();
  private lanOptIn: boolean = false;
  // Health bookkeeping: `lastFailure` is the only refusal memory the bridge keeps;
  // `listening` tracks the bound listener; `startedAt` is frozen at construction so the
  // launcher's newer-instance-wins ranking stays deterministic across heartbeat republishes.
  private lastFailure: BridgeFailureRecord | null = null;
  private listening = false;
  private healthTimer: NodeJS.Timeout | null = null;
  private readonly startedAt = Date.now();
  // Discovery files this process last published through the DACL'd atomic write,
  // keyed by target path and pinned to that file object's identity. Refreshing the
  // same object in place keeps its verified protected DACL, so the 5 s heartbeat
  // spawns no icacls/powershell (each spawn cost seconds of CPU, every beat).
  private readonly publishedDiscoveryFiles = new Map<string, { dev: bigint; ino: bigint; size: number }>();
  private persistRunning: Promise<void> | null = null;
  // The host an agent tab must be minted on and the capsule it is stamped with, resolved
  // through the app's shell/capsule directory (wired in index.ts). Never set means every
  // mint lands on the construction host — the single-window bootstrap semantics.
  private mintHostResolver?: BridgeMintHostResolver;
  private persistQueued: Promise<void> | null = null;

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
    if (grant.revoked) return null;
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
    controlPlaneRuntime?: ControlPlaneRuntime,
    closeAdmission?: PageCloseAdmission
  ) {
    this.tabHost = tabHost;
    this.isDev = isDev;
    this.closeAdmission = closeAdmission;
    this.port = isDev && port === 20129 ? 20130 : port;
    // Ephemeral-port instances (tests, smoke runners, CI) are private instances: they
    // must never publish discovery metadata or populate the shared pairing queue, which
    // belong to the live app's data root. Otherwise a finishing test run deletes the
    // running app's discovery file and drains its pairing queue, and the MCP launcher
    // then reports MCP_BRIDGE_OFFLINE.
    this.publishesDiscovery = port !== 0;

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
    this.pairingQueueDir = this.publishesDiscovery
      ? path.join(StorageLocations.getRuntimeDir(), 'pairing-queue')
      : path.join(os.tmpdir(), `antifan-pairing-${process.pid}-${Date.now().toString(36)}-${Math.random().toString(16).slice(2, 8)}`);
    BridgeServer.instance = this;
    this.wireTabHostEvents();
    void this.replenishPairingQueue().catch((err) => {
      console.warn('[antifan] Background replenishPairingQueue failed:', err);
    });
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
  public setCloseAdmission(admission?: PageCloseAdmission): void {
    this.closeAdmission = admission;
  }
  /**
   * Installs the mint-routing seam: which window's host an agent tab is created on and
   * which capsule it is stamped with. Optional only for standalone/test instances; the
   * app wires it so a `project:<id>` terminal's anchor never lands in another window's
   * host or under the process-wide ambient capsule.
   */
  public setMintHostResolver(resolver?: BridgeMintHostResolver): void {
    this.mintHostResolver = resolver;
  }

  /**
   * Direct-RPC operations (switchTab/closeTab/getDOM/captureScreenshot/evalJS) act
   * on the window's host that OWNS the target tab — a mint can land a tab on a
   * different window than the bootstrap one, so `this.tabHost` alone answers
   * TARGET_CLOSED (or worse, a foreign window's active-tab data) for foreign-owned
   * tabs. Unset → single-window behavior (construction host).
   */
  private tabHostResolver?: (tabId: string) => NativeTabHost | undefined;
  public setTabHostResolver(resolver?: (tabId: string) => NativeTabHost | undefined): void {
    this.tabHostResolver = resolver;
  }

  /** The owning host for a known tab id, or the construction host when unresolvable/absent. */
  private hostForRpcTab(tabId?: string): NativeTabHost {
    if (tabId && this.tabHostResolver) {
      const owner = this.tabHostResolver(tabId);
      if (owner) return owner;
    }
    return this.tabHost;
  }
  public async rotateToken(): Promise<string> {
    this.token = this.resolveMasterToken();

    // Terminate existing master-token WebSocket connections while preserving attachment-scoped clients
    for (const client of Array.from(this.clients)) {
      if (!this.socketAttachmentIds.has(client)) {
        try {
          client.close(4001, 'Bridge token rotated: connection invalidated');
        } catch {}
        this.clients.delete(client);
      }
    }

    // Rotation invalidates all derived grants (mobile + extension) — no stale
    // scoped credential may outlive the master secret that minted it.
    for (const grant of this.mobileGrants.values()) {
      grant.revoked = true;
    }
    for (const grant of this.extensionGrants.values()) {
      grant.revoked = true;
    }

    // Discovery metadata write carries DACL spawns; awaited last so callers that
    // await rotateToken observe the persisted file, while the synchronous
    // invalidation above is already visible to non-awaiting callers.
    await this.persistBridgeInfo();
    return this.token;
  }

  private resolveMasterToken(): string {
    const injected = process.env.ANTIFAN_BENCHMARK === '1' ? process.env.ANTIFAN_BRIDGE_TOKEN : undefined;
    if (typeof injected === 'string' && injected.length >= 16) return injected;
    return randomUUID();
  }

  public revokeMobileGrant(token: string): boolean {
    const grant = this.mobileGrants.get(token);
    if (!grant) return false;
    grant.revoked = true;
    return true;
  }

  public revokeExtensionGrant(token: string): boolean {
    const grant = this.extensionGrants.get(token);
    if (!grant) return false;
    grant.revoked = true;
    return true;
  }

  public async setLanOptIn(optIn: boolean): Promise<void> {
    const next = Boolean(optIn);
    if (next === this.lanOptIn) return;
    this.lanOptIn = next;
    if (this.httpServer && this.httpServer.listening) {
      await this.rebindListener();
    }
  }

  public isLanOptIn(): boolean {
    return this.lanOptIn;
  }

  /** Bind host: loopback unless LAN opt-in is enabled (opt-in must not silently leave the port on the LAN). */
  private effectiveBindHost(): string {
    return this.lanOptIn ? '0.0.0.0' : '127.0.0.1';
  }

  private async rebindListener(): Promise<void> {
    const port = this.port;
    const targetHost = this.effectiveBindHost();
    const oldServer = this.httpServer;
    const oldWss = this.wss;
    this.httpServer = null;
    this.wss = null;
    this.listening = false;
    const conns = new Set<WebSocket>();
    if (oldWss) {
      oldWss.clients.forEach((c) => conns.add(c));
    }
    try {
      if (oldServer) {
        oldServer.removeAllListeners('error');
        oldServer.close();
      }
    } catch {}
    await new Promise<void>((r) => setTimeout(r, 50));
    // Close surviving sockets after the old listener is gone.
    for (const c of conns) {
      try { c.close(4001, 'Bridge listener rebound'); } catch {}
    }

    const handler = this.createHttpHandler();
    const newServer = http.createServer(handler);
    const newWss = new WebSocketServer({
      server: newServer,
      handleProtocols: (protocols: Set<string>) => {
        if (protocols.has('antifan-auth')) return 'antifan-auth';
        if (protocols.has('antifan')) return 'antifan';
        return false;
      },
    });
    this.httpServer = newServer;
    this.wss = newWss;
    this.setupWssEvents();

    await new Promise<void>((resolve, reject) => {
      newServer.once('error', (err: NodeJS.ErrnoException) => {
        this.listening = false;
        this.recordBridgeFailure('LISTEN_REBIND_FAILED', 'bridge listener rebind failed');
        reject(err);
      });
      newServer.listen(port, targetHost, () => {
        const address = newServer.address();
        if (address && typeof address === 'object') {
          this.port = address.port;
        }
        this.listening = true;
        void this.persistBridgeInfo();
        emitBridgeHealthChanged();
        resolve();
      });
    });
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

  public replenishPairingQueue(): Promise<void> {
    // Concurrent callers (ctor warm-up, claim-triggered refills, the HTTP
    // challenge handler) share one in-flight replenish instead of spawning
    // duplicate icacls/powershell batches.
    if (!this.pairingReplenishInFlight) {
      this.pairingReplenishInFlight = this.replenishPairingQueueNow().finally(() => {
        this.pairingReplenishInFlight = null;
      });
    }
    return this.pairingReplenishInFlight;
  }

  private async replenishPairingQueueNow(): Promise<void> {
    if (this.isDisposed) return;
    if (!fs.existsSync(this.pairingQueueDir)) {
      fs.mkdirSync(this.pairingQueueDir, { recursive: true });
      if (process.platform === 'win32') {
        try {
          const sid = await resolveCurrentUserSid();
          await enforceProtectedDirectoryDacl(this.pairingQueueDir, sid);
        } catch {}
      }
    }

    if (this.isDisposed) return;
    let existing: string[];
    try {
      existing = fs.readdirSync(this.pairingQueueDir);
    } catch (err) {
      // The queue dir can vanish mid-replenish when dispose() runs during an
      // in-flight async refill; that teardown race is not a real failure.
      if ((err as NodeJS.ErrnoException)?.code === 'ENOENT') return;
      throw err;
    }
    const now = Date.now();
    let activeCount = 0;
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
    const itemsToWrite: Array<{ targetPath: string; content: string }> = [];
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
        pid: process.pid,
      };
      const challengePath = path.join(this.pairingQueueDir, `challenge-${challengeId}.json`);
      itemsToWrite.push({
        targetPath: challengePath,
        content: JSON.stringify(challengeData, null, 2),
      });
    }
    if (itemsToWrite.length > 0 && !this.isDisposed) {
      await this.atomicWriteManyWithDacl(itemsToWrite);
    }
  }

  public async claimPairingChallenge(clientClass: 'mcp' | 'mobile' = 'mcp'): Promise<{ code: string; expiresAt: number; challengeId?: string } | null> {
    try {
      if (!fs.existsSync(this.pairingQueueDir)) {
        try {
          await this.replenishPairingQueue();
        } catch {}
      }
      if (!fs.existsSync(this.pairingQueueDir)) return null;

      for (let attempt = 0; attempt < 2; attempt++) {
        const files = fs.readdirSync(this.pairingQueueDir).filter(f => f.startsWith('challenge-') && f.endsWith('.json'));
        if (files.length === 0) {
          try {
            await this.replenishPairingQueue();
          } catch {}
          continue;
        }
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

          // A challenge file may outlive the process that minted it: the queue directory
          // is shared across restarts, while the code registry is per-instance. The code
          // is a same-user bearer credential carrying its own expiry, so adopt it into
          // this instance instead of handing out a code that exchange rejects as
          // PAIRING_CODE_NOT_FOUND.
          const codeHash = hashSecret(data.code);
          if (!this.pairingStore.has(codeHash)) {
            this.pairingStore.set(codeHash, {
              codeHash,
              clientClass: data.clientClass === 'mobile' ? 'mobile' : 'mcp',
              ttlMs: Math.max(10_000, data.expiresAt - now),
              createdAt: now,
              expiresAt: data.expiresAt,
              consumed: false,
              revoked: false,
              attemptBudget: 3,
              failedAttempts: 0,
            });
          }

          setImmediate(() => {
            void this.replenishPairingQueue().catch((err) => {
              console.warn('[antifan] Background replenishPairingQueue failed:', err);
            });
          });
          return { code: data.code, expiresAt: data.expiresAt, challengeId: data.challengeId };
        }

        if (hasExpiredOrCorrupt) {
          try {
            await this.replenishPairingQueue();
          } catch {}
        } else {
          break;
        }
      }
    } catch {}
    return null;
  }
  private async atomicWriteManyWithDacl(items: Array<{ targetPath: string; content: string }>): Promise<void> {
    if (!items || items.length === 0) return;
    // A write queued before dispose() must not land afterwards: the final 'down'
    // record and `unlinkDiscoveryIfOwned` already ran, so a late bridge-info or
    // pairing write would resurrect a stale record the teardown just removed.
    if (this.isDisposed) return;
    const prepared: Array<{ targetPath: string; content: string; tempPath: string }> = [];
    for (const item of items) {
      const parentDir = path.dirname(item.targetPath);
      if (!fs.existsSync(parentDir)) {
        fs.mkdirSync(parentDir, { recursive: true });
      }
      const tempPath = path.join(
        parentDir,
        `.${path.basename(item.targetPath)}.tmp.${Date.now()}-${Math.random().toString(16).slice(2)}`
      );
      // Create empty temp file first and lock DACL before writing sensitive secret payload
      fs.writeFileSync(tempPath, '', { encoding: 'utf8', mode: 0o600 });
      prepared.push({ targetPath: item.targetPath, content: item.content, tempPath });
    }

    try {
      // Apply protected DACL to all empty temp files in ONE batched call before writing content
      await applyProtectedPathsDaclBridge(prepared.map((p) => p.tempPath));

      // Write content and atomic rename with fallback
      if (this.isDisposed) return; // dispose() raced the DACL batch: drop, never resurrect
      for (const p of prepared) {
        fs.writeFileSync(p.tempPath, p.content, { encoding: 'utf8', mode: 0o600 });
        try {
          fs.renameSync(p.tempPath, p.targetPath);
        } catch {
          // Windows rename fallback: apply protected DACL to target BEFORE writing content
          try {
            if (!fs.existsSync(p.targetPath)) {
              fs.writeFileSync(p.targetPath, '', { encoding: 'utf8', mode: 0o600 });
            }
            await applyProtectedPathsDaclBridge([p.targetPath]);
            fs.writeFileSync(p.targetPath, p.content, { encoding: 'utf8', mode: 0o600 });
            try {
              fs.unlinkSync(p.tempPath);
            } catch {}
          } catch (fallbackErr) {
            try { fs.unlinkSync(p.targetPath); } catch {}
            try { fs.unlinkSync(p.tempPath); } catch {}
            throw fallbackErr;
          }
        }
      }

      // Verify and enforce protected DACL on all final target files in ONE batched call
      await applyProtectedPathsDaclBridge(prepared.map((p) => p.targetPath));
    } catch (err) {
      // dispose() can delete the queue dir while an async write is in flight;
      // that teardown ENOENT is not a real write failure.
      if (!(this.isDisposed && (err as NodeJS.ErrnoException)?.code === 'ENOENT')) {
        throw err;
      }
    } finally {
      // Ensure any leftover temp files are cleaned up if an error occurred
      for (const p of prepared) {
        if (fs.existsSync(p.tempPath)) {
          try { fs.unlinkSync(p.tempPath); } catch {}
        }
      }
    }
  }

  private async atomicWriteWithDacl(targetPath: string, content: string): Promise<void> {
    await this.atomicWriteManyWithDacl([{ targetPath, content }]);
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
              this.recordPairingRefusal('PAIRING_CODE_NOT_FOUND');
              res.writeHead(401, responseHeaders);
              res.end(JSON.stringify({ error: 'PAIRING_CODE_NOT_FOUND', message: 'Pairing code not found or invalid' }));
              return;
            }

            if (record.revoked) {
              this.recordPairingRefusal('PAIRING_CODE_REVOKED');
              res.writeHead(403, responseHeaders);
              res.end(JSON.stringify({ error: 'PAIRING_CODE_REVOKED', message: 'Pairing code has been revoked' }));
              return;
            }

            if (record.consumed) {
              this.recordPairingRefusal('PAIRING_CODE_ALREADY_USED');
              res.writeHead(409, responseHeaders);
              res.end(JSON.stringify({ error: 'PAIRING_CODE_ALREADY_USED', message: 'Pairing code has already been consumed (replay rejected)' }));
              return;
            }

            if (Date.now() > record.expiresAt) {
              this.recordPairingRefusal('PAIRING_CODE_EXPIRED');
              res.writeHead(410, responseHeaders);
              res.end(JSON.stringify({ error: 'PAIRING_CODE_EXPIRED', message: 'Pairing code has expired' }));
              return;
            }

            if (record.failedAttempts >= record.attemptBudget) {
              record.revoked = true;
              this.recordPairingRefusal('PAIRING_ATTEMPTS_EXCEEDED');
              res.writeHead(429, responseHeaders);
              res.end(JSON.stringify({ error: 'PAIRING_ATTEMPTS_EXCEEDED', message: 'Pairing code attempt budget exceeded; code revoked' }));
              return;
            }

            if (record.clientClass !== clientClass) {
              record.failedAttempts++;
              this.recordPairingRefusal('PAIRING_CLIENT_CLASS_MISMATCH');
              res.writeHead(403, responseHeaders);
              res.end(JSON.stringify({
                error: 'PAIRING_CLIENT_CLASS_MISMATCH',
                message: `Pairing code intended for client class '${record.clientClass}', received '${clientClass}'`,
              }));
              return;
            }

            if (record.clientId && clientId && record.clientId !== clientId) {
              record.failedAttempts++;
              this.recordPairingRefusal('PAIRING_CLIENT_ID_MISMATCH');
              res.writeHead(403, responseHeaders);
              res.end(JSON.stringify({ error: 'PAIRING_CLIENT_ID_MISMATCH', message: 'Client ID does not match bound pairing record' }));
              return;
            }

            const grantRanks: Record<string, number> = { read: 1, write: 2, execute: 3, eval: 4 };
            // An unknown grant name used to pass straight through to the attachment, where it made
            // every capability invisible: fail-closed, but with nothing to explain why. Refuse it
            // by name so a typo surfaces as a pairing error instead of a mystery POLICY_DENIED.
            if (requestedGrant !== undefined && (typeof requestedGrant !== 'string' || !(requestedGrant in grantRanks))) {
              record.failedAttempts++;
              this.recordPairingRefusal('PAIRING_GRANT_UNKNOWN');
              res.writeHead(400, responseHeaders);
              res.end(JSON.stringify({
                error: 'PAIRING_GRANT_UNKNOWN',
                message: `Requested grant '${String(requestedGrant)}' is not one of ${Object.keys(grantRanks).join(', ')}`,
              }));
              return;
            }
            if (requestedGrant && record.requestedGrantCeiling) {
              const requestedRank = grantRanks[requestedGrant] ?? 99;
              const ceilingRank = grantRanks[record.requestedGrantCeiling] ?? 0;
              if (requestedRank > ceilingRank) {
                record.failedAttempts++;
                this.recordPairingRefusal('PAIRING_GRANT_CEILING_EXCEEDED');
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
              const suppliedTabId = typeof data.tabId === 'string' && data.tabId.trim() ? data.tabId.trim() : undefined;
              const terminalSessionId = typeof data.terminalSessionId === 'string' && data.terminalSessionId.trim() ? data.terminalSessionId.trim() : undefined;
              const evidenceTabId = suppliedTabId || binding?.browserTarget?.tabId;
              if (suppliedTabId && !this.hostTabExists(suppliedTabId, this.hostForRpcTab(suppliedTabId))) {
                throw new CapabilityError('TARGET_STALE', 'Pairing anchor tab is not live in this bridge');
              }
              const measuredWorkspace = this.controlPlaneRuntime?.resolveBrowserSessionWorkspace({
                tabId: evidenceTabId,
                originTerminalSessionId: terminalSessionId,
                cwd: typeof data.cwd === 'string' ? data.cwd : undefined,
              });
              const projectId = measuredWorkspace?.projectId || binding?.projectId || 'default-project';
              const workspaceId = measuredWorkspace?.id || binding?.workspaceId || 'default-workspace';
              const lease = binding?.lease ? { ...binding.lease, projectId, workspaceId } : {
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
              // Record where the authority came from. A silent fall back to 'write' is what turns a
              // missing `requestedGrant` into an unexplained POLICY_DENIED much later on an eval-risk
              // capability (anti.browser.evaluate / anti.inspect.eval), which reads like an
              // --allow-eval problem and is not one. The default stays fail-closed; it is just loud.
              const grantSource: 'requested' | 'ceiling' | 'default' = requestedGrant
                ? 'requested'
                : record.requestedGrantCeiling
                ? 'ceiling'
                : 'default';
              const grant = (requestedGrant || record.requestedGrantCeiling || 'write') as 'read' | 'write' | 'execute' | 'eval';
              if (grantSource === 'default') {
                console.warn(
                  '[BridgeServer] MCP pairing declared no requestedGrant; minting attachment with grant ' +
                    "'write'. Eval-risk capabilities (anti.browser.evaluate, anti.inspect.eval) will be " +
                    'refused with POLICY_DENIED. Send requestedGrant in /api/pairing/exchange to avoid this.'
                );
              }
              const autoTabId = typeof this.tabHost.getAutomationTabId === 'function' ? this.tabHost.getAutomationTabId() : undefined;

              // The tab an agent session is bound to comes from either an explicit request or
              // authority the caller already holds: its runtime binding, or the tab that was
              // explicitly designated for automation. The window's foreground tab is deliberately
              // not a candidate — with more than one project window it silently bound the session
              // to another window's tab. A session that arrives with none of these stays unbound
              // and `antifan.cli.startSession` provisions the dedicated agent tab it needs.
              const effectiveTabId =
                suppliedTabId ||
                binding?.browserTarget?.tabId ||
                (autoTabId && this.hostTabExists(autoTabId, this.hostForRpcTab(autoTabId)) ? autoTabId : undefined);

              const browserTarget: BrowserTarget | undefined = effectiveTabId
                ? {
                    projectId,
                    workspaceId,
                    runtimeId: lease.runtimeId,
                    tabId: effectiveTabId,
                    browserEpoch: binding?.browserTarget?.browserEpoch ?? lease.hostEpoch ?? 1,
                    documentGeneration: (typeof this.tabHost.getDocumentGeneration === 'function'
                      ? this.tabHost.getDocumentGeneration(effectiveTabId)
                      : undefined) ?? binding?.browserTarget?.documentGeneration ?? 1,
                    ...(binding?.browserTarget?.url ? { url: binding.browserTarget.url } : {}),
                  }
                : undefined;

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
                  tabId: effectiveTabId,
                  browserTarget,
                  browserEpoch: browserTarget?.browserEpoch,
                  documentGeneration: browserTarget?.documentGeneration,
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
                grantSource,
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
        // A depleted or fully expired queue is refilled before responding so the
        // caller that observed the empty queue still receives a challenge instead
        // of a spurious 404.
        let challenge = await this.claimPairingChallenge('mcp');
        if (!challenge) {
          try {
            await this.replenishPairingQueue();
          } catch (err) {
            console.warn('[antifan] Challenge replenishPairingQueue failed:', err);
          }
          challenge = await this.claimPairingChallenge('mcp');
        }
        const responseHeaders: Record<string, string> = { 'Content-Type': 'application/json' };
        if (isAllowedOrigin) responseHeaders['Access-Control-Allow-Origin'] = rawOrigin;

        if (!challenge) {
          this.recordPairingRefusal('CHALLENGE_QUEUE_DEPLETED');
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
          this.recordPairingRefusal('EXPIRED_GRANT');
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
        // An attachment credential is an agent credential, so /status may not answer it with the
        // foreground tab: it is answered from its own bound target, or refused by name. The master
        // token and the user-plane grants keep reading the presenting host's own state.
        res.end(JSON.stringify(this.getStatus(verifiedAttachmentId && !isBridgeToken ? { attachmentId: verifiedAttachmentId } : undefined)));
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
          if (imgBuf.length === 0) {
            // A target with no live compositor surface yields an empty capture. Answering 200
            // with a 0-byte body would be indistinguishable from a real image for the caller.
            res.writeHead(503, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ error: 'TARGET_STALE', message: 'Failed to capture a non-empty screenshot: the target has no live compositor surface' }));
          } else {
            const headers: Record<string, string> = { 'Content-Type': 'image/png' };
            if (isAllowedOrigin) headers['Access-Control-Allow-Origin'] = rawOrigin;
            res.writeHead(200, headers);
            res.end(imgBuf);
          }
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
          this.recordPairingRefusal('ATTACHMENT_SECRET_INVALID');
          res.writeHead(401, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: 'Unauthorized: Invalid or expired attachment secret' }));
          return;
        }

        const record = this.attachmentRegistry.getAttachment(verifiedAttachmentId);
        if (!record || record.state !== 'active' || Date.now() > record.expiresAt) {
          this.recordPairingRefusal('ATTACHMENT_RECORD_INACTIVE');
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
            const rawCookies: ExtensionCookieInput[] = Array.isArray(data.cookies)
              ? data.cookies
              : (Array.isArray(data.upserted) ? data.upserted : []);
            // Removals are unsupported, but a mixed batch must not drop the
            // upserts it carries: a user logout (cause 'explicit') otherwise
            // rejects every legitimate cookie in the same delta. Only a batch
            // that is *purely* removals is refused outright — that contract is
            // pinned by native-messaging-e2e-pipeline.test.ts.
            const removalsSkipped = rawRemoved.length;
            if (removalsSkipped > 0 && rawCookies.length === 0) {
              res.writeHead(400, responseHeaders);
              res.end(JSON.stringify({
                success: false,
                error: 'REMOVALS_UNSUPPORTED',
                message: 'Cookie removal propagation is unsupported. This endpoint only supports one-way additive cookie hydration.',
              }));
              return;
            }
            if (removalsSkipped > 0) {
              console.warn(`[antifan] /api/cookies/import: ignoring ${removalsSkipped} removal entr${removalsSkipped === 1 ? 'y' : 'ies'} in mixed batch; hydrating ${rawCookies.length} upsert(s)`);
            }
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
              const targetHost = this.hostForRpcTab(targetTabId);
              if (!this.hostTabExists(targetTabId, targetHost)) {
                res.writeHead(400, responseHeaders);
                res.end(JSON.stringify({ success: false, error: 'TARGET_CLOSED', message: `TARGET_CLOSED: Target tab "${targetTabId}" not found or destroyed` }));
                return;
              }
              const tabSession = targetHost.getTabSession(targetTabId);
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
                // Fail closed: no ambient/active-tab fallback. A bridge or
                // mobile credential must name an explicit target tab or
                // partition; writing cookies into whatever tab the user is
                // currently focused on is never implied.
                res.writeHead(400, responseHeaders);
                res.end(JSON.stringify({ success: false, error: 'TARGET_REQUIRED', message: 'TARGET_REQUIRED: cookie import without attachment claims requires explicit tabId or partition.' }));
                return;
              }
            }

            let importedCount = 0;
            let skippedCount = 0;
            let failedCount = 0;
            const persistSession = data.persistSessionCookies !== false;
            // Identity cookies are refused ahead of every other filter, and
            // ahead of every credential class that can reach this route - not
            // only the companion extension grant. Overwriting the auth half of
            // an already signed-in jar with another browser's copy is what
            // invalidates the session server-side, so no caller is allowed to
            // do it.
            const identityCookies = rawCookies.filter((c: ExtensionCookieInput) => isIdentityCookieName(c.name));
            const importableCookies = rawCookies.filter((c: ExtensionCookieInput) => !isIdentityCookieName(c.name));
            const candidateCookies = verifiedExtensionGrant
              ? (verifiedExtensionGrant.allowedDomains && verifiedExtensionGrant.allowedDomains.length > 0
                  ? importableCookies.filter((c: ExtensionCookieInput) => {
                      const domain = c.domain ? (c.domain.startsWith('.') ? c.domain.slice(1) : c.domain) : '';
                      return verifiedExtensionGrant.allowedDomains.some(rawAllowed => {
                        const allowed = rawAllowed.startsWith('.') ? rawAllowed.slice(1) : rawAllowed;
                        return domain === allowed || domain.endsWith('.' + allowed);
                      });
                    })
                  : [])
              : importableCookies;
            // Everything removed before the import loop is reported, never
            // silently discarded: a response carrying only `totalReceived` and
            // zeroed counters is indistinguishable from a successful empty
            // sync, which is how a scope mismatch stays hidden.
            const filteredCount = rawCookies.length - candidateCookies.length;
            if (identityCookies.length > 0) {
              const names = [...new Set(identityCookies.map((c) => c.name))].join(', ');
              console.warn(`[antifan] cookie import refused ${identityCookies.length} identity cookie(s) (${names}) for ${requestedPartition || resolvedTargetTabId || 'unspecified target'}`);
            }
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
              filteredCount,
              authRejectedCount: identityCookies.length,
              totalReceived: rawCookies.length,
              targetTabId: resolvedTargetTabId ?? (data.tabId || 'unspecified'),
              targetPartition: requestedPartition || (resolvedTargetTabId ? `tab:${resolvedTargetTabId}` : 'unspecified'),
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
    // The heartbeat rides the discovery record the whole time this process is
    // alive: `updatedAt` is the liveness readers judge, including while the
    // listener is still unbound and the record honestly reads 'down'.
    this.ensureHealthTimer();
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
          // The port-0 retry recovers this server, but every client pinned to
          // the configured port now fails — record the refusal before rebinding.
          this.listening = false;
          this.recordBridgeFailure('LISTEN_EADDRINUSE', 'configured bridge port already in use');
          console.log(`[antifan] Port ${this.port} is busy. Retrying with port 0...`);
          try {
            this.wss?.close();
          } catch {}
          try {
            this.httpServer?.removeAllListeners('error');
            this.httpServer?.close();
          } catch {}
          const altServer = http.createServer(this.createHttpHandler());
          altServer.on('error', (altErr) => {
            this.listening = false;
            this.recordBridgeFailure('LISTEN_FAILED', 'bridge listener failed to start');
            reject(altErr);
          });
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

          altServer.listen(0, this.effectiveBindHost(), () => {
            const addr = altServer.address();
            if (addr && typeof addr === 'object') {
              this.port = addr.port;
            }
            this.listening = true;
            setTimeout(() => {
              void this.persistBridgeInfo();
            }, 1500);
            emitBridgeHealthChanged();
            resolve(this.port);
          });
        } else {
          this.listening = false;
          this.recordBridgeFailure('LISTEN_FAILED', 'bridge listener failed to start');
          reject(err);
        }
      });

      this.httpServer.listen(this.port, this.effectiveBindHost(), () => {
        const address = this.httpServer?.address();
        if (address && typeof address === 'object') {
          this.port = address.port;
        }
        this.listening = true;
        // persistBridgeInfo carries DACL spawns per file; delay it past first
        // paint so the listening socket resolves and the window shows first.
        // Discovery consumers poll the file.
        setTimeout(() => {
          void this.persistBridgeInfo();
        }, 1500);
        emitBridgeHealthChanged();
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

    // `ws` relays the bound http server's 'error' onto the WebSocketServer, and
    // an unhandled 'error' event on an EventEmitter throws — without this the
    // listener's own 'error' handler never gets to recover the bind. Refusals
    // are still recorded there (EADDRINUSE, rebind, alt-server failures), so
    // this listener exists purely to keep the relay non-fatal.
    this.wss.on('error', () => {});


    this.wss.on('connection', (ws: WebSocket, req) => {
      const url = new URL(req.url || '/', `http://localhost`);
      const host = req.headers.host || `127.0.0.1:${this.port}`;
      // 1. Strict Query Parameter Prohibition on WebSockets
      if (url.searchParams.has('token') || url.searchParams.has('secret') || url.searchParams.has('code') || (url.search && /token=|secret=|code=/i.test(url.search))) {
        ws.close(4001, 'Unauthorized: SECRETS_IN_URL_FORBIDDEN - Tokens in URL query string are strictly prohibited');
        this.recordBridgeFailure('WS_AUTH_REFUSED', 'Unauthorized: SECRETS_IN_URL_FORBIDDEN - Tokens in URL query string are strictly prohibited');
        return;
      }

      // Loopback-by-default boundary enforcement
      const remoteIp = req.socket.remoteAddress || '';
      const isLoopback = remoteIp === '127.0.0.1' || remoteIp === '::1' || remoteIp === '::ffff:127.0.0.1';
      if (!this.lanOptIn && !isLoopback) {
        ws.close(4003, 'Forbidden: LAN access disabled');
        this.recordBridgeFailure('WS_AUTH_REFUSED', 'Forbidden: LAN access disabled');
        return;
      }

      // Token authentication: Authorization: Bearer, X-Antifan-Attachment-Secret, Sec-WebSocket-Protocol, or cookie
      const clientToken = extractAuthToken(req);
      const isBridgeToken = Boolean(clientToken && clientToken === this.token);
      const verifiedAttachmentId = clientToken ? (this.attachmentRegistry?.verifyConnectionToken(clientToken) ?? null) : null;
      const verifiedMobileGrant = clientToken ? this.getMobileGrant(clientToken) : null;
      if (!isBridgeToken && !verifiedAttachmentId && !verifiedMobileGrant) {
        ws.close(4001, 'Unauthorized: missing or invalid token');
        this.recordBridgeFailure('WS_AUTH_REFUSED', 'Unauthorized: missing or invalid token');
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
            this.recordBridgeFailure('WS_AUTH_REFUSED', 'Forbidden: untrusted origin');
            return;
          }
        } catch {
          ws.close(4003, 'Forbidden: malformed origin header');
          this.recordBridgeFailure('WS_AUTH_REFUSED', 'Forbidden: malformed origin header');
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
        const boundTabId = this.boundTabIdFor(verifiedAttachmentId);
        if (boundTabId) {
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
            // Prefer the ownership oracle; the user's per-tab pick may name a
            // terminal outside the advertised allowed list.
            const ownedSessionId = typeof this.tabHost.getOwnedTerminalSession === 'function'
              ? this.tabHost.getOwnedTerminalSession(boundTabId)
              : (typeof this.tabHost.getTabTerminalSession === 'function' ? this.tabHost.getTabTerminalSession(boundTabId) : undefined);
            initActiveTerminalSessionId = ownedSessionId && initTerminalSessions.some(s => s.id === ownedSessionId)
              ? ownedSessionId
              : initTerminalSessions[0]?.id;
          }
        }
      } else if (verifiedMobileGrant) {
        // Mobile companion: trim according to allowedScopes and user plane isolation
        if (verifiedMobileGrant.allowedScopes.includes('tabs.view')) {
          initTabs = this.tabHost.getTabList();
          initActiveTabId = this.tabHost.getActiveTabId();
        }
        if (verifiedMobileGrant.allowedScopes.includes('terminal.sync')) {
          initTerminalSessions = this.userPlaneSessions(tm.listSessions());
          const activeId = tm.getActiveSessionId();
          initActiveTerminalSessionId = initTerminalSessions.some(s => s.id === activeId)
            ? activeId
            : initTerminalSessions[0]?.id;
        }
      } else {
        // User plane Bridge client (IDE companion): only user-plane tabs and user-plane terminals
        initTabs = this.tabHost.getTabList();
        initActiveTabId = this.tabHost.getActiveTabId();
        initTerminalSessions = this.userPlaneSessions(tm.listSessions());
        const activeId = tm.getActiveSessionId();
        initActiveTerminalSessionId = initTerminalSessions.some(s => s.id === activeId)
          ? activeId
          : initTerminalSessions[0]?.id;
      }

      this.sendEvent(ws, 'antifan:init', {
        // Same rule as /status: an attachment-authenticated socket gets its own bound target (or a
        // refusal naming the missing explicit target) in `status.activeTabId`, never the foreground
        // tab of the window that happens to be presenting.
        status: this.getStatus(verifiedAttachmentId && !isBridgeToken ? { attachmentId: verifiedAttachmentId } : undefined),
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
        const connectionId = this.socketConnectionIds.get(ws);
        const registry = this.attachmentRegistry || this.controlPlaneRuntime?.runs?.attachments;
        if (connectionId && registry) {
          // The releasing half of connection-scoped renewal: an attachment whose every
          // renewing socket is gone holds a page the close gate counts as live use
          // forever — including owners whose renewals never carried a pid the
          // gone-owner sweep could check. Records another live socket still renews are
          // left alone inside `revokeForConnection`.
          registry.revokeForConnection(connectionId).catch((err) => {
            console.warn(`[antifan] connection ${connectionId} release failed:`, err);
          });
        }
      });

      ws.on('error', () => {
        this.clients.delete(ws);
        this.recordBridgeFailure('CLIENT_SOCKET_ERROR', 'client socket error');
      });
    });
  }
  /**
   * The server's own report: `down` until the listener binds (and after dispose),
   * `degraded` while the last refusal is inside the shared recency window,
   * `listening` otherwise. Derived on read, never stored.
   */
  private deriveBridgeHealth(): BridgeHealthState {
    if (this.isDisposed || !this.listening) return 'down';
    if (this.lastFailure && Date.now() - this.lastFailure.at < BRIDGE_FAILURE_RECENCY_MS) return 'degraded';
    return 'listening';
  }

  /**
   * One refusal or lost client attempt worth remembering. `message` is composed
   * server-side only: this record rides the published discovery file and its
   * `~/.gemini` mirror, so it can never echo a token, origin, or pairing code.
   */
  public recordBridgeFailure(code: string, message: string): void {
    if (this.isDisposed) return;
    this.lastFailure = { code, message, at: Date.now() };
    void this.persistBridgeInfo();
    emitBridgeHealthChanged();
  }

  /** Fixed phrases per availability code — never the client's own text. */
  private recordPairingRefusal(reasonCode: string): void {
    this.recordBridgeFailure('PAIRING_REFUSED', pairingRefusalMessage(reasonCode));
  }

  private ensureHealthTimer(): void {
    if (this.healthTimer) return;
    this.healthTimer = setInterval(() => {
      if (this.isDisposed) return;
      void this.persistBridgeInfo();
    }, BRIDGE_HEALTH_HEARTBEAT_MS);
    this.healthTimer.unref?.();
  }

  /**
   * The discovery payload every publish path shares. `health` and `lastFailure`
   * describe this process at write time; `updatedAt` is the publish stamp while
   * `startedAt` stays the frozen instance birth.
   */
  private bridgeInfoPayload(): Record<string, unknown> {
    return {
      port: this.port,
      host: this.host,
      pid: process.pid,
      startedAt: this.startedAt,
      isDev: this.isDev,
      protocolVersion: 1,
      endpoints: {
        pairingExchange: '/api/pairing/exchange',
        pairingChallenge: '/api/pairing/challenge',
        status: '/status',
        mobile: '/mobile',
        ws: '/',
      },
      health: this.deriveBridgeHealth(),
      lastFailure: this.lastFailure,
      heartbeatMs: BRIDGE_HEALTH_HEARTBEAT_MS,
      updatedAt: Date.now(),
    };
  }

  /**
   * Synchronous final publish for `dispose()`: the 'down' record must land before
   * `unlinkDiscoveryIfOwned` runs — a reader arriving between the two sees 'down',
   * never a stale 'listening'. Only files this instance owns are touched, so a
   * port-collision loser cannot erase or rewrite the winner's entry. The DACL
   * pass is skipped: the record is deleted microseconds later.
   */
  private publishFinalBridgeRecord(): void {
    const content = JSON.stringify(this.bridgeInfoPayload(), null, 2);
    const targets: string[] = [this.bridgeInfoPath];
    const geminiDir = path.join(os.homedir(), '.gemini');
    const geminiFileName = this.isDev ? 'antifan_bridge_dev.json' : 'antifan_bridge.json';
    targets.push(path.join(geminiDir, geminiFileName));
    for (const targetPath of targets) {
      try {
        if (!fs.existsSync(targetPath)) continue;
        const parsed = JSON.parse(fs.readFileSync(targetPath, 'utf8')) as { pid?: unknown };
        if (parsed?.pid !== process.pid) continue;
        const tempPath = path.join(
          path.dirname(targetPath),
          `.${path.basename(targetPath)}.tmp.${Date.now()}-${Math.random().toString(16).slice(2)}`
        );
        try {
          fs.writeFileSync(tempPath, content, 'utf8');
          fs.renameSync(tempPath, targetPath);
        } catch {
          try { fs.writeFileSync(targetPath, content, 'utf8'); } catch {}
          try { fs.unlinkSync(tempPath); } catch {}
        }
      } catch {}
    }
  }

  /**
   * Single-flight publish: at most one write runs and one waits. A full DACL'd
   * write takes seconds, so the listen publish, its 1.5 s follow-up, and the
   * heartbeat would otherwise race the same temp/rename and double every spawn.
   * The waiting run reads the payload when it starts, so every caller's state
   * change lands and every awaiting caller observes a write that includes it.
   */
  private persistBridgeInfo(): Promise<void> {
    if (this.persistQueued) return this.persistQueued;
    if (!this.persistRunning) return this.startPersist();
    this.persistQueued = this.persistRunning.then(() => {
      this.persistQueued = null;
      return this.startPersist();
    });
    return this.persistQueued;
  }

  private startPersist(): Promise<void> {
    const run = this.persistBridgeInfoNow().finally(() => {
      if (this.persistRunning === run) this.persistRunning = null;
    });
    this.persistRunning = run;
    return run;
  }

  private async persistBridgeInfoNow(): Promise<void> {
    if (this.isDisposed) return;
    if (!this.publishesDiscovery) return;
    const info = this.bridgeInfoPayload();
    try {
      const content = discoveryRecordContent(info);
      const targets: string[] = [this.bridgeInfoPath];

      const geminiDir = path.join(os.homedir(), '.gemini');
      if (fs.existsSync(geminiDir)) {
        const geminiFileName = this.isDev ? 'antifan_bridge_dev.json' : 'antifan_bridge.json';
        const mirrorPath = path.join(geminiDir, geminiFileName);
        if (this.canPublishLegacyMirror(mirrorPath)) {
          targets.push(mirrorPath);
        } else {
          console.warn(`[antifan] Keeping the existing entry in ${mirrorPath}: it is held by a live instance.`);
        }
      }

      const pending = targets.filter((targetPath) => !this.refreshPublishedDiscoveryInPlace(targetPath, content));
      if (pending.length === 0) return;
      await this.atomicWriteManyWithDacl(pending.map((targetPath) => ({ targetPath, content })));
      this.rememberPublishedDiscoveryFiles(pending, content);
      console.log(`[antifan] Persisted non-secret bridge info to ${this.bridgeInfoPath}`);
    } catch (err) {
      console.error('[antifan] Failed to persist bridge info:', err);
    }
  }

  /**
   * Overwrites a discovery file this process published and DACL-verified, in
   * place. Only the same file object (volume + file id) at the same padded size
   * qualifies: a replaced, resized, or missing file takes the full DACL'd path.
   */
  private refreshPublishedDiscoveryInPlace(targetPath: string, content: string): boolean {
    if (process.platform !== 'win32') return false;
    const published = this.publishedDiscoveryFiles.get(targetPath);
    if (!published) return false;
    const buffer = Buffer.from(content, 'utf8');
    if (buffer.length !== published.size) return false;
    let fd: number | null = null;
    try {
      fd = fs.openSync(targetPath, 'r+');
      const stat = fs.fstatSync(fd, { bigint: true });
      if (stat.dev !== published.dev || stat.ino !== published.ino || stat.size !== BigInt(published.size)) {
        this.publishedDiscoveryFiles.delete(targetPath);
        return false;
      }
      fs.writeSync(fd, buffer, 0, buffer.length, 0);
      return true;
    } catch {
      this.publishedDiscoveryFiles.delete(targetPath);
      return false;
    } finally {
      if (fd !== null) {
        try { fs.closeSync(fd); } catch {}
      }
    }
  }

  private rememberPublishedDiscoveryFiles(targetPaths: string[], content: string): void {
    if (process.platform !== 'win32' || this.isDisposed) return;
    const size = Buffer.byteLength(content, 'utf8');
    for (const targetPath of targetPaths) {
      try {
        const stat = fs.statSync(targetPath, { bigint: true });
        if (stat.size === BigInt(size)) {
          this.publishedDiscoveryFiles.set(targetPath, { dev: stat.dev, ino: stat.ino, size });
          continue;
        }
      } catch {}
      this.publishedDiscoveryFiles.delete(targetPath);
    }
  }

  /**
   * The machine-global mirror is last-writer-wins by construction, so a second
   * (dev, probe, canary) instance must not erase a live holder's entry. The
   * per-instance file is always authoritative for that instance.
   */
  private canPublishLegacyMirror(mirrorPath: string): boolean {
    try {
      if (!fs.existsSync(mirrorPath)) return true;
      const parsed = JSON.parse(fs.readFileSync(mirrorPath, 'utf8')) as { pid?: unknown };
      const holderPid = typeof parsed?.pid === 'number' && Number.isInteger(parsed.pid) && parsed.pid > 0 ? parsed.pid : null;
      if (!holderPid || holderPid === process.pid) return true;
      try {
        process.kill(holderPid, 0);
        return false; // holder is alive: its entry stays.
      } catch (err) {
        // EPERM means the holder is alive but not signalable by us; ESRCH means dead.
        return (err as NodeJS.ErrnoException)?.code !== 'EPERM';
      }
    } catch {
      return true;
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
      // A socket bound to an attachment may upgrade its own lifecycle: mint the CLI
      // session for the bound pairing attachment (startSession) or tear down its own
      // session (endSession). Both are strictly self-scoped: p.attachmentId must equal
      // the bound attachment, mirroring the renewSession cross-attachment guard.
      // Everything else (legacy RPCs, cross-attachment lifecycle) stays Forbidden.
      const selfScopedLifecycle =
        (method === 'antifan.cli.startSession' || method === 'antifan.cli.endSession') &&
        typeof p.attachmentId === 'string' &&
        boundAttachmentId !== undefined &&
        p.attachmentId === boundAttachmentId;
      if (
        boundAttachmentId &&
        !selfScopedLifecycle &&
        method !== 'antifan.capability.dispatch' &&
        method !== 'antifan.cli.renewSession' &&
        method !== 'antifan.cli.heartbeat'
      ) {
        respond(false, undefined, 'Forbidden: Attachment-authenticated connections may only invoke antifan.capability.dispatch, antifan.cli.renewSession, antifan.cli.heartbeat, or session lifecycle for the bound attachment');
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
          cleanMethod === 'terminalSwitchSession' ||
          cleanMethod === 'terminalGetFullBuffer'
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

        // Prevent mobile client from operating on agent-owned terminal sessions. Only methods
        // that target a session fall back to the active one: listing and session creation stay
        // reachable so the companion can render (and extend) the user-plane session list.
        const rawSessionId = typeof p.id === 'string' ? p.id : (typeof p.sessionId === 'string' ? p.sessionId : undefined);
        const targetSessionId = rawSessionId?.trim() || undefined;
        const targetsTerminalSession =
          cleanMethod === 'terminalInput' ||
          cleanMethod === 'terminalSendKey' ||
          cleanMethod === 'terminalResize' ||
          cleanMethod === 'terminalCloseSession' ||
          cleanMethod === 'terminalRenameSession' ||
          cleanMethod === 'terminalRestart' ||
          cleanMethod === 'terminalSwitchSession' ||
          cleanMethod === 'terminalGetFullBuffer';
        const effectiveTerminalId = targetSessionId || (targetsTerminalSession ? TerminalManager.getInstance().getActiveSessionId() : undefined);
        if (effectiveTerminalId && !this.userPlaneMayReachTerminal(effectiveTerminalId)) {
          respond(false, { code: 'TERMINAL_FORBIDDEN', message: 'Access to agent-owned terminal is forbidden' }, 'TERMINAL_FORBIDDEN: Access to agent-owned terminal is forbidden');
          return;
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

            const sessionFilter = (attachmentId && this.sessionCapabilityFilters.get(attachmentId))
              || (attachmentId && this.controlPlaneRuntime?.capabilities?.getSessionFilter(attachmentId));
            if (sessionFilter && !isCapabilityNamePermitted(p.name, sessionFilter)) {
              const code = 'REFUSED_TOOL_SURFACE';
              const message = `Capability '${p.name}' is forbidden by session tool surface policy`;
              respond(false, {
                code,
                message,
                details: { capability: p.name, filter: sessionFilter }
              }, `${code}: ${message}`);
              break;
            }
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
          // Minting a session and provisioning an agent tab is new work: a committed quit
          // must refuse it rather than create something the teardown already passed.
          this.assertApplicationAdmitsWork('antifan.cli.startSession');
          if (!this.controlPlaneRuntime) {
            respond(false, undefined, 'Control plane runtime is not available');
            break;
          }
          try {
            // Hoisted: the terminal id both steers tab selection below and stamps the
            // minted attachment's origin so the control plane scopes it to the
            // terminal's own project (and re-checks that scope on every dispatch).
            const terminalSessionId = typeof p.terminalSessionId === 'string' && p.terminalSessionId.trim() ? p.terminalSessionId.trim() : undefined;
            const terminalGen = typeof p.terminalGeneration === 'string' || typeof p.terminalGeneration === 'number' ? p.terminalGeneration : undefined;
            let tabId = typeof p.tabId === 'string' && p.tabId.trim() ? p.tabId.trim() : undefined;
            const requestProjectId = typeof p.projectId === 'string' && p.projectId.trim() ? p.projectId.trim() : undefined;
            // Every mint/lookup below runs on the host that owns the terminal or the
            // attachment's bound tab — never the construction host. The resolved host and
            // pinned capsule travel together so tab ownership, affinity, and capsule agree.
            let mintTarget: BridgeMintTargetResolution | undefined;
            if (tabId) {
              mintTarget = this.resolveMintTarget({ boundTabId: tabId });
              const targetHost = mintTarget?.host ?? this.tabHost;
              const canonical = typeof targetHost.resolveTargetTabId === 'function'
                ? targetHost.resolveTargetTabId(tabId)
                : undefined;
              const effective = canonical ?? tabId;
              if (!this.hostTabExists(effective, targetHost)) {
                throw new Error(`TAB_NOT_FOUND: The specified tabId '${tabId}' does not exist or was closed.`);
              }
              tabId = effective;
            } else {
              if (terminalSessionId) {
                mintTarget = this.resolveMintTarget({ terminalSessionId });
                const sessionHost = mintTarget?.host ?? this.tabHost;
                if (typeof sessionHost.getTerminalAgentAffinity === 'function') {
                  const affinity = sessionHost.getTerminalAgentAffinity(terminalSessionId, terminalGen);
                  if (affinity) {
                    if (affinity.status === 'alive' && this.hostTabExists(affinity.tabId, sessionHost)) {
                      tabId = affinity.tabId;
                    } else {
                      const closedNotice = affinity.lastUrl ? `(${affinity.lastUrl})` : `(${affinity.tabId})`;
                      console.warn(
                        `[antifan] startSession: tab previously attached to terminal ${terminalSessionId}#${terminalGen} ${closedNotice} was closed or dead; auto-provisioning a replacement agent tab.`
                      );
                    }
                  }
                }
                if (!tabId) {
                  const currentAutoTab = typeof sessionHost.getAutomationTabId === 'function' ? sessionHost.getAutomationTabId() : undefined;
                  if (currentAutoTab && this.hostTabExists(currentAutoTab, sessionHost)) {
                    const isOffscreen = typeof sessionHost.isTabOffscreen === 'function' && sessionHost.isTabOffscreen(currentAutoTab);
                    const tabList = typeof sessionHost.getTabList === 'function' ? sessionHost.getTabList() : [];
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
                      if (typeof sessionHost.bindTerminalAgentAffinity === 'function') {
                        sessionHost.bindTerminalAgentAffinity(terminalSessionId, terminalGen, currentAutoTab);
                      }
                    }
                  }
                }
                if (!tabId) {
                  console.warn(`[antifan] startSession: terminal ${terminalSessionId}#${terminalGen} has no affinity in this instance (pid ${process.pid}); provisioning a local agent tab. A foreign attach was likely corrected.`);
                  // The anchor is minted on the terminal's owning window and stamped with
                  // the terminal's capsule — the ambient capsule is never a substitute.
                  tabId = sessionHost.createTab('about:blank', false, {
                    offscreen: true,
                    ephemeral: true,
                    ...(mintTarget?.capsuleId ? { capsuleId: mintTarget.capsuleId } : {}),
                  });
                  if (typeof sessionHost.bindTerminalAgentAffinity === 'function') {
                    sessionHost.bindTerminalAgentAffinity(terminalSessionId, terminalGen, tabId);
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
                const ownTabId = this.boundTabIdFor(targetAttachmentId);
                if (ownTabId) {
                  mintTarget = this.resolveMintTarget({ boundTabId: ownTabId });
                  tabId = ownTabId;
                } else {
                  // A fresh provision pins the capsule the caller's project claim resolves
                  // to — validated by the resolver, so an unknown/ambiguous claim pins nothing.
                  mintTarget = this.resolveMintTarget({ projectId: requestProjectId });
                  const mintHost = mintTarget?.host ?? this.tabHost;
                  tabId = mintHost.createTab('about:blank', false, {
                    offscreen: true,
                    ephemeral: true,
                    ...(mintTarget?.capsuleId ? { capsuleId: mintTarget.capsuleId } : {}),
                  });
                }
              }
            }
            // Fail loud before a session exists: a session bound to a tab that was
            // never provisioned (or already died) turns every later call into a
            // confusing target error, and hides the real cause.
            if (!tabId || !this.hostTabExists(tabId, mintTarget?.host)) {
              throw new Error(`TAB_NOT_FOUND: no live agent tab is available for this session (tabId '${tabId || 'none provisioned'}')`);
            }
            // Phase 2: intentionally no `setAutomationTabId(tabId)` here. Each
            // attachment's binding lives in its own authority record; writing the
            // session's tab onto the process-global automation target would let one
            // session clobber another's bound invocation.
            const allowedCapabilityNames = Array.isArray(p.allowedCapabilityNames)
              ? p.allowedCapabilityNames.map(String)
              : typeof p.allowedCapabilityNames === 'string'
              ? p.allowedCapabilityNames.split(',').map((s: string) => s.trim()).filter(Boolean)
              : undefined;
            const forbiddenCapabilityNames = Array.isArray(p.forbiddenCapabilityNames)
              ? p.forbiddenCapabilityNames.map(String)
              : typeof p.forbiddenCapabilityNames === 'string'
              ? p.forbiddenCapabilityNames.split(',').map((s: string) => s.trim()).filter(Boolean)
              : undefined;
            const filterObj = p.capabilityFilter && typeof p.capabilityFilter === 'object' ? p.capabilityFilter as Record<string, unknown> : undefined;
            const effectiveAllowed = allowedCapabilityNames ?? (Array.isArray(filterObj?.allowedCapabilityNames) ? (filterObj!.allowedCapabilityNames as unknown[]).map(String) : undefined);
            const effectiveForbidden = forbiddenCapabilityNames ?? (Array.isArray(filterObj?.forbiddenCapabilityNames) ? (filterObj!.forbiddenCapabilityNames as unknown[]).map(String) : undefined);
            const hasFilter = Boolean((effectiveAllowed && effectiveAllowed.length > 0) || (effectiveForbidden && effectiveForbidden.length > 0));
            const sessionFilter: SessionCapabilityFilter | undefined = hasFilter ? {
              allowedCapabilityNames: effectiveAllowed,
              forbiddenCapabilityNames: effectiveForbidden,
            } : undefined;

            const ownerPid = typeof p.ownerPid === 'number' && p.ownerPid > 0 ? p.ownerPid : undefined;
            const res = await this.controlPlaneRuntime.createCliSession({
              projectId: requestProjectId,
              workspaceId: typeof p.workspaceId === 'string' ? p.workspaceId : undefined,
              cwd: typeof p.cwd === 'string' ? p.cwd : undefined,
              backendId: p.backendId || 'cli',
              grant: p.grant || 'eval',
              tabId,
              browserEpoch: p.browserEpoch,
              ttlMs: typeof p.ttlMs === 'number' ? Math.min(Math.max(p.ttlMs, 10_000), 86_400_000) : 7_200_000,
              ownerPid,
              originTerminalSessionId: terminalSessionId,
            });
            if (sessionFilter) {
              this.sessionCapabilityFilters.set(res.launch.attachmentId, sessionFilter);
              if (res.run?.id) this.sessionCapabilityFilters.set(res.run.id, sessionFilter);
              if (res.attempt?.id) this.sessionCapabilityFilters.set(res.attempt.id, sessionFilter);
              if (this.controlPlaneRuntime?.capabilities) {
                this.controlPlaneRuntime.capabilities.setSessionFilter(res.launch.attachmentId, sessionFilter);
                if (res.run?.id) this.controlPlaneRuntime.capabilities.setSessionFilter(res.run.id, sessionFilter);
                if (res.attempt?.id) this.controlPlaneRuntime.capabilities.setSessionFilter(res.attempt.id, sessionFilter);
              }
            }
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
              allowedCapabilityNames: effectiveAllowed,
              forbiddenCapabilityNames: effectiveForbidden,
              // Where the stdio proxy's own bounded core.* attempt store lives
              // (provenance `omp-proxy`, unit `proxy-attempt`). This bridge is
              // the only producer: the launcher forwards the value to the agent
              // child as ANTIFAN_PROXY_TELEMETRY_DIR, and a proxy started any
              // other way (bin `antifan-mcp`, `npm run mcp`, Codex) receives no
              // directory and writes nothing — there is no fallback path. The
              // Electron main process is the documented-safe caller of
              // getDataRoot() (directories are initialized before the bridge is
              // wired), so no probe happens on a CLI path here.
              proxyTelemetryDir: path.join(StorageLocations.getDataRoot(), 'telemetry', 'core-attempts'),
              // Which Electron instance answered. The launcher compares this with
              // its own pinned pid to detect a foreign attach (non-secret).
              runtimePid: process.pid,
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
            if (p.attachmentId) {
              this.sessionCapabilityFilters.delete(p.attachmentId);
              this.controlPlaneRuntime?.capabilities?.removeSessionFilter(p.attachmentId);
            }
            if (p.runId) {
              this.sessionCapabilityFilters.delete(p.runId);
              this.controlPlaneRuntime?.capabilities?.removeSessionFilter(p.runId);
            }
            if (p.attemptId) {
              this.sessionCapabilityFilters.delete(p.attemptId);
              this.controlPlaneRuntime?.capabilities?.removeSessionFilter(p.attemptId);
            }
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
            // The renewing transport's identity: the registry counts this socket among
            // the record's live owners and releases it when the last one closes — the
            // only reachable release for an attachment whose renewals carry no pid.
            let connectionId = this.socketConnectionIds.get(ws);
            if (!connectionId) {
              connectionId = `conn-${randomUUID()}`;
              this.socketConnectionIds.set(ws, connectionId);
            }
            // Forwarded untouched through the runtime seam to the registry, which is
            // where `connectionId` is declared (the runtime signature stays narrower).
            const renewal = { extensionMs, ownerPid, connectionId };
            const res = await this.controlPlaneRuntime.renewCliSession(attachmentId, secret, renewal);
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
          // A tab minted after the quit committed, or while a close was already authorized,
          // would arrive where no membership re-read can see it: the assert and the registered
          // operation bracket the creation itself, the way every sibling page RPC is gated.
          this.assertApplicationAdmitsWork('antifan.openTab');
          const isAgentCaller = Boolean(boundAttachmentId || p.attachmentId);
          const activate = Boolean(p.activate ?? false);
          // Asking to activate a tab means the tab must exist on screen: an
          // offscreen/ephemeral surface cannot be focused, so activation opts the
          // tab into the visible plane instead of silently creating a hidden one.
          const wantsVisibleTab = p.userFacing === true || activate;
          const isEphemeral = isAgentCaller ? (p.ephemeral !== false && !wantsVisibleTab) : Boolean(p.ephemeral);
          // Phase 2 (step 11): agent-created tabs are dedicated offscreen surfaces so
          // capture never foregrounds/attaches the user's visible view. Forward the
          // offscreen option through the adapter; default offscreen for agent callers.
          const isOffscreen = isAgentCaller ? (p.offscreen !== false && !wantsVisibleTab) : Boolean(p.offscreen);
          // The tab does not exist yet, so the operation is attributed to the page the caller
          // is working from: that is the page whose window owns the new tab, and the window's
          // own close is the attempt that would otherwise destroy it mid-mint.
          const boundTabId = this.boundTabIdFor(boundAttachmentId);
          // A bound attachment whose recorded tab is gone must refuse: minting under
          // the construction host's arbitrary active tab is the same wrong-window
          // land-and-die shape this routing exists to kill.
          if (boundAttachmentId && !boundTabId) {
            const registry = this.attachmentRegistry || this.controlPlaneRuntime?.runs?.attachments;
            const rec = registry?.getRecord?.(boundAttachmentId);
            const recordedTabId = rec?.tabId || rec?.browserTarget?.tabId;
            if (recordedTabId) {
              throw new CapabilityError(
                'TARGET_STALE',
                `antifan.openTab refused: the bound tab '${recordedTabId}' for attachment '${boundAttachmentId}' is dead; minting under another window's active tab would orphan the new tab outside the attachment's project`,
                { boundAttachmentId, boundTabId: recordedTabId, recovery: 'rebind_target to a live tab in the attachment project' }
              );
            }
          }
          const targetTabId = boundTabId || this.tabHost.getActiveTabId?.() || undefined;
          const release = this.admitDirectRpcOperation('antifan.openTab', targetTabId);
          try {
            // The new tab belongs to the window its attributed tab belongs to and carries
            // that tab's capsule — minting on the construction host would land it (and its
            // lifecycle) in whichever window happened to boot first.
            const mintTarget = this.resolveMintTarget({ boundTabId: targetTabId });
            const mintHost = mintTarget?.host ?? this.tabHost;
            const tabId = mintHost.createTab(p.url, activate, {
              ephemeral: isEphemeral,
              offscreen: isOffscreen,
              ...(isAgentCaller ? { plane: 'agent' as const } : {}),
              ...(mintTarget?.capsuleId ? { capsuleId: mintTarget.capsuleId } : {}),
            });
            respond(true, { tabId });
          } finally {
            release();
          }
          break;
        }

        case 'switchTab':
        case 'antifan.switchTab': {
          const ok = this.hostForRpcTab(typeof p.tabId === 'string' ? p.tabId : undefined)
            .switchTab(p.tabId, { plane: 'agent' });
          respond(ok, { switched: ok });
          break;
        }

        case 'closeTab':
        case 'antifan.closeTab': {
          const ok = this.hostForRpcTab(typeof p.tabId === 'string' ? p.tabId : undefined)
            .closeTab(p.tabId, 'bridge-rpc');
          respond(ok, { closed: ok });
          break;
        }

        case 'navigate':
        case 'antifan.navigate': {
          this.assertApplicationAdmitsWork('antifan.navigate');
          const target = this.resolveDirectRpcTargetTab(p.tabId, boundAttachmentId, p.attachmentId);
          if ('error' in target) {
            respond(false, undefined, target.error);
            break;
          }
          const release = this.admitDirectRpcOperation('antifan.navigate', target.tabId);
          try {
            const ok = this.hostForRpcTab(target.tabId).navigate(target.tabId, p.url);
            respond(ok, { navigated: ok });
          } finally {
            release();
          }
          break;
        }

        case 'reload':
        case 'antifan.reload': {
          this.assertApplicationAdmitsWork('antifan.reload');
          const target = this.resolveDirectRpcTargetTab(p.tabId, boundAttachmentId, p.attachmentId);
          if ('error' in target) {
            respond(false, undefined, target.error);
            break;
          }
          const release = this.admitDirectRpcOperation('antifan.reload', target.tabId);
          try {
            const ok = this.hostForRpcTab(target.tabId).reload(target.tabId);
            respond(ok, { reloaded: ok });
          } finally {
            release();
          }
          break;
        }

        case 'goBack':
        case 'antifan.goBack': {
          this.assertApplicationAdmitsWork('antifan.goBack');
          const target = this.resolveDirectRpcTargetTab(p.tabId, boundAttachmentId, p.attachmentId);
          if ('error' in target) {
            respond(false, undefined, target.error);
            break;
          }
          const release = this.admitDirectRpcOperation('antifan.goBack', target.tabId);
          try {
            const ok = this.hostForRpcTab(target.tabId).goBack(target.tabId);
            respond(ok, { wentBack: ok });
          } finally {
            release();
          }
          break;
        }

        case 'goForward':
        case 'antifan.goForward': {
          this.assertApplicationAdmitsWork('antifan.goForward');
          const target = this.resolveDirectRpcTargetTab(p.tabId, boundAttachmentId, p.attachmentId);
          if ('error' in target) {
            respond(false, undefined, target.error);
            break;
          }
          const release = this.admitDirectRpcOperation('antifan.goForward', target.tabId);
          try {
            const ok = this.hostForRpcTab(target.tabId).goForward(target.tabId);
            respond(ok, { wentForward: ok });
          } finally {
            release();
          }
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
              // An agent attachment is scoped to its own session; a companion grant follows the
              // user-plane rule; a master-token socket is unscoped and addresses any session.
              const attachmentOwnsSession = !boundAttachmentId
                || this.terminalWriteForAttachment(p.sessionId, boundAttachmentId, p.attachmentId);
              const mobileMayDrive = !mobileGrant || this.mobileMayDriveTerminal(mobileGrant, p.sessionId);
              if (!attachmentOwnsSession || !mobileMayDrive) {
                respond(false, undefined, 'TERMINAL_FORBIDDEN: caller may not operate this terminal session');
                break;
              }
              await this.holdProcessAdmission('terminalInput', () => tm.writeTo(p.sessionId, p.text));
            } else if (boundAttachmentId) {
              // Attachment callers must never fall back to the user's active shell.
              // Reject with TERMINAL_FORBIDDEN unless a sessionId is required.
              respond(false, undefined, 'TERMINAL_FORBIDDEN: terminalSessionId is required for attachment input');
              break;
            } else if (mobileGrant) {
              const effectiveSessionId = tm.getActiveSessionId();
              const mobileMayDrive = this.mobileMayDriveTerminal(mobileGrant, effectiveSessionId);
              if (!mobileMayDrive) {
                respond(false, undefined, 'TERMINAL_FORBIDDEN: caller may not operate this terminal session');
                break;
              }
              await this.holdProcessAdmission('terminalInput', () => tm.write(p.text));
            } else {
              await this.holdProcessAdmission('terminalInput', () => tm.write(p.text));
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
              // Same plane resolution as terminalInput: an agent attachment and a companion grant
              // are gated, a master-token socket is unscoped.
              const attachmentOwnsSession = !boundAttachmentId
                || this.terminalWriteForAttachment(p.sessionId, boundAttachmentId, p.attachmentId);
              const mobileMayDrive = !mobileGrant || this.mobileMayDriveTerminal(mobileGrant, p.sessionId);
              if (!attachmentOwnsSession || !mobileMayDrive) {
                respond(false, undefined, 'TERMINAL_FORBIDDEN: caller may not operate this terminal session');
                break;
              }
              await this.holdProcessAdmission('terminalSendKey', () => tm.writeTo(p.sessionId, sequence));
            } else if (boundAttachmentId) {
              respond(false, undefined, 'TERMINAL_FORBIDDEN: terminalSessionId is required for attachment key input');
              break;
            } else if (mobileGrant) {
              const effectiveSessionId = tm.getActiveSessionId();
              const mobileMayDrive = this.mobileMayDriveTerminal(mobileGrant, effectiveSessionId);
              if (!mobileMayDrive) {
                respond(false, undefined, 'TERMINAL_FORBIDDEN: caller may not operate this terminal session');
                break;
              }
              await this.holdProcessAdmission('terminalSendKey', () => tm.write(sequence));
            } else {
              await this.holdProcessAdmission('terminalSendKey', () => tm.write(sequence));
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
          const sessions = this.visibleTerminalSessions(tm.listSessions(), mobileGrant);
          respond(true, {
            // A companion sees exactly the sessions it may operate: agent terminals stay hidden
            // from the mobile surface, matching its connect payload and terminal data frames.
            sessions,
            activeSessionId: this.visibleTerminalActiveId(sessions),
          });
          break;
        }

        case 'terminalGetFullBuffer':
        case 'antifan.terminalGetFullBuffer': {
          // The transcript RPC: session broadcasts carry only preview tails, so the
          // companion phone fetches the full retained buffer here — the same
          // getFullBuffer the desktop renderer hydrates from. Mobile grants already
          // passed the terminal.sync + user-plane gate above; a bound attachment may
          // only read a session it owns.
          const tm = TerminalManager.getInstance();
          const targetId = typeof p.sessionId === 'string' && p.sessionId.trim()
            ? p.sessionId.trim()
            : tm.getActiveSessionId();
          if (mobileGrant && !this.userPlaneMayReachTerminal(targetId)) {
            respond(false, undefined, 'TERMINAL_FORBIDDEN: caller may not read an agent-owned terminal session');
            break;
          }
          respond(true, await Promise.resolve(tm.getFullBuffer(targetId)));
          break;
        }

        case 'terminalSwitchSession':
        case 'antifan.terminalSwitchSession': {
          if (typeof p.sessionId === 'string') {
            const tm = TerminalManager.getInstance();
            if (mobileGrant && !this.userPlaneMayReachTerminal(p.sessionId)) {
              respond(false, undefined, 'TERMINAL_FORBIDDEN: caller may not target an agent-owned terminal session');
              break;
            }
            const switched = await this.holdProcessAdmission('terminalSwitchSession', () => tm.switchSession(p.sessionId));
            respond(switched, {
              switched,
              activeSessionId: this.visibleTerminalActiveId(this.visibleTerminalSessions(tm.listSessions(), mobileGrant)),
            });
          } else {
            respond(false, undefined, 'Missing sessionId');
          }
          break;
        }

        case 'terminalNewSession':
        case 'antifan.terminalNewSession': {
          const tm = TerminalManager.getInstance();
          // The caller's workspace, not the daemon's ambient selection: a PTY filed under
          // whichever capsule the daemon happens to hold is invisible to the window that asked
          // for it. An explicit capsule on the request wins; otherwise it comes from the tab
          // this caller is bound to, the same affiliation the neighbouring terminal cases
          // resolve their target through.
          const explicitCapsuleId = typeof p.capsuleId === 'string' && p.capsuleId.trim() ? p.capsuleId.trim() : undefined;
          const boundTabId = this.boundTabIdFor(boundAttachmentId);
          const capsuleId = explicitCapsuleId
            // A bound tab that carries no capsule means no project claims its terminal, which
            // is the sentinel — not the daemon's ambient capsule, which another window set.
            ?? (boundTabId ? this.tabHost.getTabCapsuleId?.(boundTabId) || DEFAULT_TERMINAL_CAPSULE_ID : undefined);
          // A PTY minted after the quit committed would outlive the windows that asked for it,
          // and admitting before this await would not prove the mint is still allowed when it
          // happens: the assert and the registration share one synchronous step.
          // Ownership is the agent's own, never the window its bound tab sits in: a bridge socket
          // mints on behalf of an agent surface, so the row must not fall into a project window's
          // sidebar scope. A caller with no bound tab mints `agent:unbound` — never a project key.
          const sessionId = await this.holdProcessAdmission('terminalNewSession', () =>
            tm.createSession(p.cwd, capsuleId, agentTerminalOwnerKey(boundTabId))
          );
          const sessions = this.visibleTerminalSessions(tm.listSessions(), mobileGrant);
          respond(true, {
            sessionId,
            sessions,
          });
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
          if (mobileGrant && !this.mobileMayDriveTerminal(mobileGrant, targetId)) {
            respond(false, undefined, 'TERMINAL_FORBIDDEN: caller may not operate this terminal session');
            break;
          }
          const closed = await tm.closeSession(targetId);
          const sessions = this.visibleTerminalSessions(tm.listSessions(), mobileGrant);
          respond(closed, {
            closed,
            sessions,
            activeSessionId: this.visibleTerminalActiveId(sessions),
          });
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
          if (mobileGrant && !this.mobileMayDriveTerminal(mobileGrant, targetId)) {
            respond(false, undefined, 'TERMINAL_FORBIDDEN: caller may not operate this terminal session');
            break;
          }
          const renamed = await tm.renameSession(targetId, p.name || '');
          const sessions = this.visibleTerminalSessions(tm.listSessions(), mobileGrant);
          respond(renamed, {
            renamed,
            sessions,
          });
          break;
        }
        case 'terminalRestart':
        case 'antifan.terminalRestart': {
          const tm = TerminalManager.getInstance();
          if (mobileGrant) {
            const effectiveSessionId = p.sessionId || tm.getActiveSessionId();
            if (!this.mobileMayDriveTerminal(mobileGrant, effectiveSessionId)) {
              respond(false, undefined, 'TERMINAL_FORBIDDEN: caller may not operate this terminal session');
              break;
            }
          }
          // Same ownership rule as terminalNewSession above: a restart through a bridge socket is an
          // agent mint. The replaced record keeps its own owner, and a restart that has to spawn the
          // manager's first record takes this key instead of the ambient one — never a project window's.
          await this.holdProcessAdmission('terminalRestart', () =>
            tm.restart(p.cwd, agentTerminalOwnerKey(this.boundTabIdFor(boundAttachmentId)))
          );
          respond(true, { restarted: true });
          break;
        }

        case 'terminalResize':
        case 'antifan.terminalResize': {
          const tm = TerminalManager.getInstance();
          if (mobileGrant) {
            const effectiveSessionId = p.sessionId || tm.getActiveSessionId();
            if (!this.mobileMayDriveTerminal(mobileGrant, effectiveSessionId)) {
              respond(false, undefined, 'TERMINAL_FORBIDDEN: caller may not operate this terminal session');
              break;
            }
          }
          const cols = Number(p.cols) || 80;
          const rows = Number(p.rows) || 24;
          // The daemon-backed facade answers asynchronously: an unawaited resize would report
          // success for a resize the host refused and leave its rejection unhandled.
          if (p.sessionId) {
            await tm.resizeTo(p.sessionId, cols, rows);
          } else {
            await tm.resize(cols, rows);
          }
          respond(true, { resized: true, cols, rows });
          break;
        }

        case 'getTabs':
        case 'antifan.getTabs': {
          // Both halves of this snapshot come from one host, so a caller is never handed one
          // window's tab list beside another window's active tab. Attachment-authenticated
          // sockets are refused above, before reaching it: an agent names its own target, it is
          // never shown the foreground tab.
          respond(true, { tabs: this.tabHost.getTabList(), activeTabId: this.tabHost.getActiveTabId() });
          break;
        }

        case 'getDOM':
        case 'antifan.getDOM': {
          const targetTabId = (typeof p.tabId === 'string' && p.tabId.trim())
            ? p.tabId.trim()
            : (this.boundTabIdFor(boundAttachmentId) || this.tabHost.getActiveTabId?.() || undefined);
          const release = this.admitDirectRpcOperation('antifan.getDOM', targetTabId);
          try {
            const dom = await this.hostForRpcTab(targetTabId).getDom(p.selector, targetTabId, p.paneId);
            respond(true, { html: dom });
          } finally {
            release();
          }
          break;
        }

        case 'captureScreenshot':
        case 'antifan.captureScreenshot': {
          const targetTabId = (typeof p.tabId === 'string' && p.tabId.trim())
            ? p.tabId.trim()
            : (this.boundTabIdFor(boundAttachmentId) || this.tabHost.getActiveTabId?.() || undefined);
          const release = this.admitDirectRpcOperation('antifan.captureScreenshot', targetTabId);
          try {
            const imageBase64 = await this.hostForRpcTab(targetTabId).captureScreenshot(undefined, targetTabId, p.paneId);
            if (!imageBase64 || imageBase64.length === 0) {
              // A target with no live compositor surface yields an empty capture; reporting it as
              // a successful capture would hand clients a 0-byte image.
              const message = 'Failed to capture a non-empty screenshot: the target has no live compositor surface';
              respond(false, { code: 'TARGET_STALE', message }, `TARGET_STALE: ${message}`);
              break;
            }
            respond(true, { imageBase64 });
          } finally {
            release();
          }
          break;
        }

        case 'evalJS':
        case 'antifan.evalJS': {
          const targetTabId = (typeof p.tabId === 'string' && p.tabId.trim())
            ? p.tabId.trim()
            : (this.boundTabIdFor(boundAttachmentId) || this.tabHost.getActiveTabId?.() || undefined);
          const release = this.admitDirectRpcOperation('antifan.evalJS', targetTabId);
          try {
            const result = await this.hostForRpcTab(targetTabId).evalJs(p.expression, targetTabId, p.paneId);
            respond(true, { result });
          } finally {
            release();
          }
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
          // Mirror the reloadUi refusal (:2506-2513). Without this guard any
          // attachment-bound connection — including an agent working in a tab — could
          // end the whole desktop the user is working in.
          if (boundAttachmentId) {
            respond(false, undefined, 'FORBIDDEN: Attachment-bound connections cannot quit the desktop');
            break;
          }
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
            color: typeof p.color === 'string' ? p.color : undefined,
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
      if (err instanceof CapabilityError) {
        respond(false, { code: err.code, message: err.message, details: err.details }, `${err.code}: ${err.message}`);
        return;
      }
      const errorMsg = err instanceof Error ? err.message : String(err);
      respond(false, undefined, errorMsg);
    }
  }
  private getEffectiveAdmission(): PageCloseAdmission | undefined {
    if (this.closeAdmission) return this.closeAdmission;
    const hostSeam = this.tabHost as unknown as { closeAdmission?: PageCloseAdmission };
    return hostSeam.closeAdmission;
  }

  private assertApplicationAdmitsWork(surface: string): void {
    const admission = this.getEffectiveAdmission();
    if (!admission) return;
    let applicationReserved = false;
    try {
      if (typeof admission.isApplicationAdmissionReserved === 'function') {
        applicationReserved = Boolean(admission.isApplicationAdmissionReserved());
      }
    } catch (err) {
      const cause = err instanceof Error ? err.message : String(err);
      throw new CapabilityError(
        'RUNTIME_DRAINING',
        `${surface} refused: the application admission state could not be read (${cause}); no new work is admitted while it is unknown. Retry shortly.`,
        { applicationAdmissionUnreadable: true }
      );
    }
    if (applicationReserved) {
      throw new CapabilityError(
        'RUNTIME_DRAINING',
        `${surface} refused: the application is quitting and admits no new work. Retry once the quit finishes or is refused.`,
        { applicationQuitting: true }
      );
    }
  }

  private admitDirectRpcOperation(surface: string, tabId?: string): () => void {
    this.assertApplicationAdmitsWork(surface);
    const admission = this.getEffectiveAdmission();
    if (!admission) return () => {};

    const hostSeam = this.tabHost as unknown as { automationTabId?: string };
    const target = tabId || hostSeam.automationTabId || '';
    if (target) {
      let pageReserved = false;
      try {
        if (typeof admission.isPageReserved === 'function') {
          pageReserved = Boolean(admission.isPageReserved(target));
        }
      } catch (err) {
        const cause = err instanceof Error ? err.message : String(err);
        throw new CapabilityError(
          'TARGET_STALE',
          `${surface} refused on tab '${target}': the close reservation could not be read (${cause}). Retry, or rebind to a live tab.`,
          { tabId: target, closeReservationUnreadable: true }
        );
      }
      if (pageReserved) {
        throw new CapabilityError(
          'TARGET_STALE',
          `${surface} refused: page '${target}' is reserved for close`,
          { tabId: target, reservedForClose: true }
        );
      }
    }

    if (typeof admission.beginAdmittedOperation !== 'function') return () => {};
    // Attributed to the page AND to its window's owner. A page count alone is invisible to a
    // shell close when the target is an offscreen or ephemeral tab: those are not member pages
    // of any shell, so the window would be torn down while this operation is still in flight
    // and the close report would call it clean.
    const release = admission.beginAdmittedOperation(
      target ? [target] : undefined,
      target ? this.hostWindowOwnerKey() : undefined
    );
    let released = false;
    return () => {
      if (released) return;
      released = true;
      try {
        release();
      } catch (err) {
        console.warn(`[close-admission] release failed for ${surface}:`, err);
      }
    };
  }

  /**
   * The owner key of the window this host presents — the identity a shell-scope close
   * attempt for it carries — or undefined when the host cannot answer.
   *
   * Read for the owner half of an admitted operation's attribution. A host whose seam
   * predates that attribution, or a test double standing in for one, names no owner and
   * the operation stays attributed to its page alone.
   */
  private hostWindowOwnerKey(): string | undefined {
    const host = this.tabHost as unknown as { windowOwnerKey?: () => unknown };
    if (typeof host.windowOwnerKey !== 'function') return undefined;
    const key = host.windowOwnerKey();
    return typeof key === 'string' && key.trim().length > 0 ? key : undefined;
  }

  /**
   * Admit one operation that belongs to the process rather than to a page.
   *
   * The terminal RPCs mint inside the daemon after the call resolves, so an assert that
   * happens before the await proves nothing about the moment the PTY exists. This asserts and
   * registers in one synchronous step, and the registration is process-wide on purpose: these
   * RPCs name no page, and attributing them to `automationTabId` or the active tab — what
   * `admitDirectRpcOperation` falls back to for a call with no explicit target — would refuse
   * an unrelated page's close for a write that never reached it.
   */
  private admitProcessOperation(surface: string): () => void {
    this.assertApplicationAdmitsWork(surface);
    const admission = this.getEffectiveAdmission();
    if (!admission || typeof admission.beginAdmittedOperation !== 'function') return () => {};
    const release = admission.beginAdmittedOperation();
    let released = false;
    return () => {
      if (released) return;
      released = true;
      try {
        release();
      } catch (err) {
        console.warn(`[close-admission] release failed for ${surface}:`, err);
      }
    };
  }

  /**
   * Run one bridge operation under a process-scoped admission, held until the work settles:
   * a PTY minted inside the daemon is only measurable by the close gate this way.
   */
  private async holdProcessAdmission<T>(surface: string, work: () => T | Promise<T>): Promise<T> {
    const release = this.admitProcessOperation(surface);
    try {
      return await work();
    } finally {
      release();
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
    if (!ownedTabId) return false;
    // The gate IS the membership check: isTerminalAllowedForTab honors only live
    // affinity entries, so a pool-only or unbound tab can never write here.
    if (typeof this.tabHost.isTerminalAllowedForTab === 'function') {
      return this.tabHost.isTerminalAllowedForTab(ownedTabId, sessionId);
    }
    const ownedTerminalIds = typeof this.tabHost.getOwnedTerminalSession === 'function'
      ? this.tabHost.getOwnedTerminalSession(ownedTabId)
      : (typeof this.tabHost.getTabTerminalSession === 'function' ? this.tabHost.getTabTerminalSession(ownedTabId) : undefined);
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
    // Canonicalize, existence-check, and activity-stamp on the host that OWNS the
    // tab: a minted tab living on a second project window is invisible to the
    // bootstrap host, so resolving or probing on this.tabHost rejects live
    // foreign-window tabs as TARGET_CLOSED before the op can route to them.
    const candidateHost = this.hostForRpcTab(candidateTabId);
    const canonical = typeof candidateHost.resolveTargetTabId === 'function'
      ? candidateHost.resolveTargetTabId(candidateTabId)
      : undefined;
    const effective = canonical ?? candidateTabId;
    const owningHost = this.hostForRpcTab(effective);
    if (!this.hostTabExists(effective, owningHost)) {
      return { code: 'TARGET_CLOSED', error: `TARGET_CLOSED: Target tab '${candidateTabId}' not found or destroyed` };
    }
    owningHost.noteAgentTabActivity?.(effective);
    return { tabId: effective };
  }

  /**
   * The host a mint must run on plus the capsule the new tab is stamped with.
   *
   * Terminal-scoped mints are pinned to the terminal's OWN window and capsule: the
   * construction host (the bootstrap window's) used to answer every mint, so an
   * anchor for a terminal owned by another project's window landed — and later
   * died — in the wrong window under that window's workspace capsule.
   *
   * Claim rule: a terminal stamped `project:<id>` (or a malformed `project:` key)
   * must mint ONLY under a capsule the resolver verified for its own project. No
   * owning host, or no resolvable capsule, is a real claim with no provable scope —
   * minting anyway would put the anchor under the ambient capsule of another window.
   */
  private resolveMintTarget(opts: BridgeMintTargetRequest): BridgeMintTargetResolution | undefined {
    const tm = TerminalManager.getInstance();
    const terminalSessionId = typeof opts.terminalSessionId === 'string' && opts.terminalSessionId.trim() ? opts.terminalSessionId.trim() : undefined;
    // 'default' is the daemon's unattributed sentinel, not a workspace stamp — a session
    // carrying it must never pin a tab under that literal id.
    const stampedCapsuleId = terminalSessionId ? tm.sessionCapsuleId(terminalSessionId) : undefined;
    const capsuleId = stampedCapsuleId === DEFAULT_TERMINAL_CAPSULE_ID ? undefined : stampedCapsuleId;
    const ownerKey = terminalSessionId
      ? (typeof tm.sessionOwnerKey === 'function' ? tm.sessionOwnerKey(terminalSessionId) : undefined)
      : undefined;
    const parsedOwner = parseOwnerKey(ownerKey);
    const projectClaimed = parsedOwner.kind === 'project' || parsedOwner.kind === 'malformed';
    const resolution = this.mintHostResolver?.({ ...opts, terminalSessionId });
    if (projectClaimed && (!resolution?.host || !resolution.capsuleId)) {
      throw new CapabilityError(
        'TERMINAL_SCOPE_UNRESOLVED',
        `TERMINAL_SCOPE_UNRESOLVED: Cannot mint an agent tab from terminal '${terminalSessionId}': a project owns it, but no owning window ` +
          `or verified capsule could be resolved for it. The anchor would land in the ambient capsule of another window.`,
        { terminalSessionId, ownerKey }
      );
    }
    if (!resolution) {
      return capsuleId ? { host: this.tabHost, capsuleId } : undefined;
    }
    // The resolver is authoritative on the capsule: it verified the stamp against the live
    // capsule store, so a dropped/undefined capsuleId there means "mint unpinned", never
    // "resurrect whatever the session happened to be stamped with".
    return { host: resolution.host, capsuleId: resolution.capsuleId };
  }

  /** Defensive tab-existence check: hasTab is an optional host capability.
   *  When the host cannot verify (no hasTab), treat as existing so an
   *  unverifiable target never crashes the bridge — the op still fails closed
   *  at the authority/resolution layer if the tab is truly unknown. `host` is the
   *  owning window's host; it defaults to the construction host. */
  private hostTabExists(tabId?: string | null, host?: NativeTabHost): boolean {
    const target = host ?? this.tabHost;
    if (!tabId) return false;
    if (typeof target.hasTab === 'function') return target.hasTab(tabId);
    const list = typeof target.getTabList === 'function' ? target.getTabList() : [];
    if (Array.isArray(list)) {
      return list.some((tab: unknown) => {
        if (!tab || typeof tab !== 'object' || !('id' in tab)) return false;
        const tabIdValue = (tab as { id?: unknown }).id;
        return tabIdValue === tabId;
      });
    }
    return true;
  }

  /**
   * The tab an attachment-bound invocation is pinned to, or undefined when it holds no
   * live target. The answer comes from the caller's own record, so a binding that was
   * revoked — or a tab that has since closed — can never be served from another
   * window's tab.
   */
  private boundTabIdFor(attachmentId?: string | null): string | undefined {
    if (!attachmentId) return undefined;
    const registry = this.attachmentRegistry || this.controlPlaneRuntime?.runs?.attachments;
    const record = registry ? registry.getRecord(attachmentId) : undefined;
    const boundTabId = record?.tabId || record?.browserTarget?.tabId;
    return boundTabId && this.hostTabExists(boundTabId, this.hostForRpcTab(boundTabId)) ? boundTabId : undefined;
  }

  /**
   * The active-tab answer an agent-plane caller may be handed: its own authenticated
   * target, or a refusal naming the missing explicit target. A zero-argument
   * "active tab" query is never answered from the focused window, because an agent's
   * authority is its attachment, not the tab the user happens to be looking at.
   */
  private agentPlaneActiveTab(attachmentId?: string | null): { tabId?: string; refusal?: string } {
    const boundTabId = this.boundTabIdFor(attachmentId);
    if (boundTabId) return { tabId: boundTabId };
    return {
      refusal:
        'TARGET_REQUIRED: this invocation named no tabId and its attachment holds no live bound target; the foreground tab of a window is not a substitute for agent authority',
    };
  }

  /**
   * Exact byte size of a coalesced terminal:data frame, derived from its parts rather than by
   * re-serializing the merged payload. Must stay byte-identical to the frame built at flush time in
   * `flushCongestedClient` (same key order, no whitespace).
   */
  private terminalFrameBytes(sessionIdJsonBytes: number, escapedDataBytes: number, seq: number | undefined): number {
    const seqBytes = typeof seq === 'number' ? BRIDGE_TERMINAL_FRAME_SEQ_BYTES + String(seq).length : 0;
    return (
      BRIDGE_TERMINAL_FRAME_PREFIX_BYTES +
      sessionIdJsonBytes +
      BRIDGE_TERMINAL_FRAME_MID_BYTES +
      2 + // the two quotes JSON.stringify adds around the merged data field
      escapedDataBytes +
      seqBytes +
      BRIDGE_TERMINAL_FRAME_SUFFIX_BYTES
    );
  }

  public getCongestionState(ws: WebSocket): BridgeCongestionState {
    let state = this.clientCongestion.get(ws);
    if (!state) {
      state = { queue: [], head: 0, queuedBytes: 0, droppedFrames: 0, droppedBytes: 0 };
      this.clientCongestion.set(ws, state);
    }
    return state;
  }

  private sealTerminalFrame(frame: PendingOutboundFrame): void {
    if (frame.sealed) return;
    const raw = JSON.stringify({
      event: 'antifan:terminal:data',
      data: {
        sessionId: frame.sessionId,
        data: frame.dataParts ? frame.dataParts.join('') : '',
        ...(typeof frame.seq === 'number' ? { seq: frame.seq } : {}),
      },
    });
    frame.frame = Buffer.from(raw, 'utf8');
    frame.bytes = frame.frame.byteLength;
    frame.raw = raw;
    frame.sealed = true;
    frame.coalesceKey = null;
  }

  private enforceQueueHardCap(ws: WebSocket, state: BridgeCongestionState): void {
    if (state.queuedBytes <= BRIDGE_QUEUE_HARD_CAP) return;

    // Whole-frame tail-drop: drop oldest complete frames from head of queue.
    // Drop whole frames only — never slice across frame boundaries.
    while (state.queuedBytes > BRIDGE_QUEUE_HARD_CAP && state.head < state.queue.length - 1) {
      const dropped = state.queue[state.head]!;
      state.head += 1;
      state.queuedBytes = Math.max(0, state.queuedBytes - dropped.bytes);
      state.droppedFrames += 1;
      state.droppedBytes += dropped.bytes;
    }

    if (state.head > 0 && state.head * 2 >= state.queue.length) {
      state.queue = state.queue.slice(state.head);
      state.head = 0;
    }

    // Keep dropSlowClient as the final escalation when a single frame or unavoidable growth exceeds cap.
    if (state.queuedBytes > BRIDGE_QUEUE_HARD_CAP) {
      this.dropSlowClient(ws);
    }
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
  public sendEventFrame(
    ws: WebSocket,
    event: string,
    data: unknown,
    terminalSessionId?: string,
    preSerializedRaw?: string,
    preSerializedBytes?: number,
    extractedDataText?: string,
    extractedSeq?: number,
  ): void {
    if (ws.readyState !== WebSocket.OPEN) return;

    const raw = preSerializedRaw ?? JSON.stringify({ event, data } as BridgeEventPayload);
    const bytes = preSerializedBytes ?? Buffer.byteLength(raw, 'utf8');
    let dataText = extractedDataText ?? '';
    let seq: number | undefined = extractedSeq;
    if (extractedDataText === undefined && terminalSessionId && data && typeof data === 'object') {
      if ('data' in data && data.data !== undefined) {
        dataText = String(data.data ?? '');
      }
      if ('seq' in data && typeof data.seq === 'number') {
        seq = data.seq;
      }
    }

    const state = this.getCongestionState(ws);
    const queueLen = state.queue.length - state.head;
    if (queueLen === 0 && ws.bufferedAmount + bytes <= BRIDGE_SOFT_HIGH_WATER) {
      if (state.head > 0) {
        state.queue = [];
        state.head = 0;
        state.queuedBytes = 0;
      }
      try {
        ws.send(raw);
      } catch {
        this.clients.delete(ws);
      }
      return;
    }

    if (terminalSessionId) {
      const last = state.queue.length > state.head ? state.queue[state.queue.length - 1] : undefined;
      if (last && !last.sealed && last.coalesceKey === terminalSessionId && last.dataParts) {
        // Merge by appending the chunk. The merged text is joined once upon sealing and the exact frame
        // size is maintained incrementally, so N chunks cost O(N) instead of O(N^2).
        last.dataParts.push(dataText);
        last.escapedDataBytes = (last.escapedDataBytes ?? 0) + escapedJsonStringBodyBytes(dataText);
        if (typeof seq === 'number') {
          last.seq = typeof last.seq === 'number' ? Math.max(last.seq, seq) : seq;
        }
        const mergedBytes = this.terminalFrameBytes(last.sessionIdJsonBytes ?? 0, last.escapedDataBytes, last.seq);
        state.queuedBytes += mergedBytes - last.bytes;
        last.bytes = mergedBytes;

        // Seal at 64 parts or 1MB, whichever comes first
        if (last.dataParts.length >= BRIDGE_COALESCE_MAX_PARTS || (last.escapedDataBytes ?? 0) >= BRIDGE_COALESCE_MAX_BYTES) {
          this.sealTerminalFrame(last);
        }

        this.enforceQueueHardCap(ws, state);
        if (ws.readyState === WebSocket.OPEN && this.clientCongestion.has(ws)) {
          this.armDrainPump();
        }
        return;
      }

      // If there was an unsealed frame for another session at the tail, seal it now
      if (last && !last.sealed) {
        this.sealTerminalFrame(last);
      }

      const sessionIdJsonBytes = Buffer.byteLength(JSON.stringify(terminalSessionId), 'utf8');
      const escapedDataBytes = escapedJsonStringBodyBytes(dataText);
      const initialBytes = this.terminalFrameBytes(sessionIdJsonBytes, escapedDataBytes, seq);
      const dataParts: string[] = [dataText];
      const entry: PendingOutboundFrame = {
        raw: '',
        frame: Buffer.alloc(0),
        bytes: initialBytes,
        coalesceKey: terminalSessionId,
        sessionId: terminalSessionId,
        dataParts,
        sessionIdJsonBytes,
        escapedDataBytes,
        seq,
        sealed: false,
        get data(): string {
          return entry.dataParts === undefined ? '' : entry.dataParts.join('');
        },
      };

      // Seal immediately if single chunk hits cap
      if (dataParts.length >= BRIDGE_COALESCE_MAX_PARTS || escapedDataBytes >= BRIDGE_COALESCE_MAX_BYTES) {
        this.sealTerminalFrame(entry);
      }

      state.queue.push(entry);
      state.queuedBytes += entry.bytes;
      this.enforceQueueHardCap(ws, state);
    } else {
      const last = state.queue.length > state.head ? state.queue[state.queue.length - 1] : undefined;
      if (last && !last.sealed) {
        this.sealTerminalFrame(last);
      }

      const frameBuffer = Buffer.from(raw, 'utf8');
      state.queue.push({
        raw,
        frame: frameBuffer,
        bytes: frameBuffer.byteLength,
        coalesceKey: null,
        sealed: true,
      });
      state.queuedBytes += frameBuffer.byteLength;
      this.enforceQueueHardCap(ws, state);
    }

    if (ws.readyState === WebSocket.OPEN && this.clientCongestion.has(ws)) {
      this.armDrainPump();
    }
  }

  public flushCongestedClient(ws: WebSocket): void {
    const state = this.clientCongestion.get(ws);
    if (!state || state.queue.length === 0 || ws.readyState !== WebSocket.OPEN) return;

    // Seal unsealed tail frame before iterating so send loop has pre-built Buffers only
    const last = state.queue.length > state.head ? state.queue[state.queue.length - 1] : undefined;
    if (last && !last.sealed) {
      this.sealTerminalFrame(last);
    }

    while (state.head < state.queue.length && ws.bufferedAmount < BRIDGE_SOFT_HIGH_WATER) {
      const frame = state.queue[state.head]!;
      const frameBytes = frame.bytes;
      try {
        ws.send(frame.frame);
      } catch {
        this.clients.delete(ws);
        state.queue = [];
        state.head = 0;
        state.queuedBytes = 0;
        return;
      }
      state.head += 1;
      state.queuedBytes = Math.max(0, state.queuedBytes - frameBytes);
    }

    if (state.head >= state.queue.length) {
      state.queue = [];
      state.head = 0;
      state.queuedBytes = 0;
    } else if (state.head > 0 && state.head * 2 >= state.queue.length) {
      state.queue = state.queue.slice(state.head);
      state.head = 0;
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

  /**
   * User-plane callers (a paired companion, an IDE bridge client) may reach any terminal that is
   * not agent-owned. Single oracle behind the write gates, the session lists, the connect payload,
   * the terminal-data frames, and the session broadcast.
   */
  private userPlaneMayReachTerminal(terminalSessionId?: string): boolean {
    if (!terminalSessionId) return false;
    if (typeof this.tabHost.getTerminalAgentAffinity === 'function') {
      const aff = this.tabHost.getTerminalAgentAffinity(terminalSessionId);
      if (aff && aff.status === 'alive') return false;
    }
    return true;
  }

  /** The user-plane slice of a session list: an agent-owned session is never part of it. */
  private userPlaneSessions(sessions: SessionSummary[]): SessionSummary[] {
    return sessions.filter(s => this.userPlaneMayReachTerminal(s.id));
  }

  /** What a caller sees: a companion gets the user plane, a control-plane caller sees every session. */
  private visibleTerminalSessions(sessions: SessionSummary[], mobileGrant?: MobileSessionGrant): SessionSummary[] {
    return mobileGrant ? this.userPlaneSessions(sessions) : sessions;
  }

  /**
   * The active id a caller may hold: never one outside the sessions it can see. Mirrors the connect
   * payload, so a phone cannot pick up an agent session id from a list but, response, or broadcast.
   */
  private visibleTerminalActiveId(sessions: SessionSummary[]): string {
    const activeId = TerminalManager.getInstance().getActiveSessionId();
    if (!activeId) return '';
    return sessions.some(s => s.id === activeId) ? activeId : (sessions[0]?.id || '');
  }

  private mobileMayDriveTerminal(mobileGrant: MobileSessionGrant, terminalSessionId?: string): boolean {
    return mobileGrant.allowedScopes.includes('terminal.input') && this.userPlaneMayReachTerminal(terminalSessionId);
  }

  public broadcastEvent(event: string, data: unknown): void {
    const payload: BridgeEventPayload = { event, data };
    const broadcastStartMs = performance.now();
    const isTerminalData = event === 'antifan:terminal:data';
    const isTerminalSession = event === 'antifan:terminal:session';
    let terminalSessionId: string | undefined;
    let dataText: string | undefined;
    let seq: number | undefined;

    if (isTerminalData && data && typeof data === 'object') {
      if ('sessionId' in data) {
        terminalSessionId = String(data.sessionId ?? '');
      }
      if ('data' in data && data.data !== undefined) {
        dataText = String(data.data ?? '');
      }
      if ('seq' in data && typeof data.seq === 'number') {
        seq = data.seq;
      }
    } else if (isTerminalSession && data && typeof data === 'object' && 'id' in data) {
      terminalSessionId = String(data.id ?? '');
    }

    // Pre-serialize frame payload once for all clients and benchmark
    const raw = JSON.stringify(payload);
    const rawBytes = Buffer.byteLength(raw, 'utf8');

    // A companion receives the user-plane view of a session state: the agent plane stays invisible
    // in the list, the active id, and the transcript snapshot that travels with it.
    let mobileSessionFrame: { data: unknown; raw: string; rawBytes: number } | undefined;
    if (isTerminalSession) {
      const hasCompanion = [...this.clients].some(client =>
        client.readyState === WebSocket.OPEN
        && this.socketMobileGrants.get(client)?.allowedScopes.includes('terminal.sync'));
      if (hasCompanion && data && typeof data === 'object') {
        const state = data as {
          sessions?: SessionSummary[];
          splitSessionId?: string;
        };
        const sessions = this.userPlaneSessions(Array.isArray(state.sessions) ? state.sessions : []);
        const activeId = this.visibleTerminalActiveId(sessions);
        const activeSummary = sessions.find(s => s.id === activeId);
        const mobileData = {
          ...state,
          sessions,
          activeSessionId: activeId,
          splitSessionId: activeSummary?.splitSessionId,
          snapshot: activeSummary?.buffer || '',
          snapshotThroughSeq: activeSummary?.snapshotThroughSeq || 0,
        };
        const mobileRaw = JSON.stringify({ event, data: mobileData });
        mobileSessionFrame = { data: mobileData, raw: mobileRaw, rawBytes: Buffer.byteLength(mobileRaw, 'utf8') };
      }
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
        this.sendEventFrame(client, event, data, terminalSessionId, raw, rawBytes, dataText, seq);
      } else if (isTerminalSession && mobileGrant && mobileSessionFrame) {
        this.sendEventFrame(client, event, mobileSessionFrame.data, undefined, mobileSessionFrame.raw, mobileSessionFrame.rawBytes);
      } else {
        this.sendEventFrame(client, event, data, undefined, raw, rawBytes);
      }
      sent += 1;
    }
    if (isBenchmarkEnabled()) {
      recordBenchmark({
        surface: 'bridge',
        name: 'broadcast',
        value: performance.now() - broadcastStartMs,
        extra: { event, clients: sent, congested, bytes: rawBytes },
      });
    }
  }

  public getStatus(scope?: BridgeInvocationScope): BridgeStatusAnswer {
    const answer = scope?.attachmentId
      ? this.agentPlaneActiveTab(scope.attachmentId)
      : { tabId: this.tabHost.getActiveTabId(), refusal: undefined };
    return {
      active: true,
      port: this.port,
      clientCount: this.clients.size,
      activeTabId: answer.tabId,
      ...(answer.refusal ? { activeTabRefusal: answer.refusal } : {}),
      tabCount: this.tabHost.getTabList().length,
      inspecting: false,
      health: this.deriveBridgeHealth(),
      ...(this.lastFailure ? { lastFailure: this.lastFailure } : {}),
    };
  }

  public dispose(): void {
    this.isDisposed = true;
    this.listening = false;
    if (this.publishesDiscovery) {
      // The final 'down' record lands BEFORE removal so a reader arriving in
      // between sees 'down', never a stale 'listening'. Then only discovery
      // metadata this process wrote is removed — another live instance (or a
      // port-collision fallback that lost the bind race) may own the current file.
      this.publishFinalBridgeRecord();
      this.unlinkDiscoveryIfOwned(this.bridgeInfoPath);
      const geminiDir = path.join(os.homedir(), '.gemini');
      const geminiFileName = this.isDev ? 'antifan_bridge_dev.json' : 'antifan_bridge.json';
      this.unlinkDiscoveryIfOwned(path.join(geminiDir, geminiFileName));
      this.cleanupOwnedPairingChallenges();
    } else {
      try {
        fs.rmSync(this.pairingQueueDir, { recursive: true, force: true });
      } catch {}
    }

    if (this.drainTimer) {
      clearInterval(this.drainTimer);
      this.drainTimer = null;
    }
    if (this.heartbeatTimer) {
      clearInterval(this.heartbeatTimer);
      this.heartbeatTimer = null;
    }
    if (this.healthTimer) {
      clearInterval(this.healthTimer);
      this.healthTimer = null;
    }

    for (const client of this.clients) {
      try { client.close(); } catch {}
    }
    this.clients.clear();
    this.wss?.close();
    this.httpServer?.close();
    emitBridgeHealthChanged();
  }

  private unlinkDiscoveryIfOwned(filePath: string): void {
    try {
      if (!fs.existsSync(filePath)) return;
      let ownerPid: unknown;
      try {
        ownerPid = (JSON.parse(fs.readFileSync(filePath, 'utf8')) as { pid?: unknown })?.pid;
      } catch {
        // Unreadable or corrupt: never delete a file we cannot prove we own.
        return;
      }
      if (ownerPid === process.pid) {
        fs.unlinkSync(filePath);
      }
    } catch {}
  }

  private cleanupOwnedPairingChallenges(): void {
    try {
      if (!fs.existsSync(this.pairingQueueDir)) return;
      for (const file of fs.readdirSync(this.pairingQueueDir)) {
        if (!file.startsWith('challenge-') || !file.endsWith('.json')) continue;
        try {
          const filePath = path.join(this.pairingQueueDir, file);
          const data = JSON.parse(fs.readFileSync(filePath, 'utf8')) as { pid?: unknown };
          if (data?.pid === process.pid) {
            fs.unlinkSync(filePath);
          }
        } catch {}
      }
    } catch {}
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

/**
 * Fixed server-composed phrases for each pairing/attachment availability code the
 * refusal ledger understands. The record lands in `bridge.json` and its
 * `~/.gemini` mirror, both read by other tools — it must carry a stable phrase,
 * never client-supplied text (a pairing code, a grant name, an origin string).
 */
function pairingRefusalMessage(reasonCode: string): string {
  switch (reasonCode) {
    case 'PAIRING_CODE_NOT_FOUND': return 'pairing code not found or invalid';
    case 'PAIRING_CODE_REVOKED': return 'pairing code revoked';
    case 'PAIRING_CODE_ALREADY_USED': return 'pairing code already used';
    case 'PAIRING_CODE_EXPIRED': return 'pairing code expired';
    case 'PAIRING_ATTEMPTS_EXCEEDED': return 'pairing attempt budget exhausted';
    case 'PAIRING_CLIENT_CLASS_MISMATCH': return 'pairing client class mismatch';
    case 'PAIRING_CLIENT_ID_MISMATCH': return 'pairing client id mismatch';
    case 'PAIRING_GRANT_UNKNOWN': return 'requested grant unknown';
    case 'PAIRING_GRANT_CEILING_EXCEEDED': return 'requested grant exceeds ceiling';
    case 'CHALLENGE_QUEUE_DEPLETED': return 'pairing challenge queue depleted';
    case 'EXPIRED_GRANT': return 'extension session grant expired';
    case 'ATTACHMENT_SECRET_INVALID': return 'attachment secret invalid or expired';
    case 'ATTACHMENT_RECORD_INACTIVE': return 'attachment record inactive or expired';
    case 'SECRETS_IN_URL_FORBIDDEN': return 'secrets in URL forbidden';
    default: return 'pairing refused';
  }
}
