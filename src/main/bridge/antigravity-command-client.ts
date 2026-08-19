/**
 * AntiFan Browser Desktop — Antigravity Command Client (Protocol v2)
 *
 * Implements hardened filesystem bridge dispatch, atomic file writes,
 * receipt-driven polling, timeout to 'unknown' without auto-retry,
 * and workspace-isolated transport.
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as crypto from 'node:crypto';
import {
  AntigravityCommandV2,
  AntigravityResultV2,
  AntigravityHostV2,
  AntigravityAttachmentDescriptor,
  AntigravityDeliveryRoute,
  BridgeDeliveryState,
} from '../../shared/contracts';

export interface CommandClientFsSeam {
  existsSync: (p: string) => boolean;
  readFileSync: (p: string, encoding: BufferEncoding) => string;
  writeFileSync: (p: string, data: string, encoding: BufferEncoding) => void;
  renameSync: (oldPath: string, newPath: string) => void;
  unlinkSync: (p: string) => void;
  mkdirSync: (p: string, options?: fs.MakeDirectoryOptions) => string | undefined;
  readdirSync: (p: string) => string[];
  statSync: (p: string) => fs.Stats;
}

export interface AntigravityCommandClientOptions {
  workspacePath: string;
  pollIntervalMs?: number;
  timeoutMs?: number;
  clock?: () => number;
  fsSeam?: CommandClientFsSeam;
}

export interface DispatchCommandParams {
  action: 'send-prompt' | 'abort';
  mode: 'draft' | 'auto';
  promptText: string;
  targetConversationId?: string;
  requestedRoute?: AntigravityDeliveryRoute;
  attachments?: AntigravityAttachmentDescriptor[];
  clientInstanceId?: string;
  timeoutMs?: number;
  expiresAtEpochMs?: number;
  meta?: Record<string, unknown>;
}

export function computePromptDigest(prompt: string): string {
  const normalized = (prompt || '').trim().replace(/\r\n/g, '\n');
  return crypto.createHash('sha256').update(normalized, 'utf8').digest('hex');
}

export function generateCommandId(): string {
  const timestamp = Date.now();
  const rand = crypto.randomBytes(4).toString('hex');
  return `cmd-${timestamp}-${rand}`;
}

export function validateCommandV2(data: unknown): { ok: boolean; error?: string; command?: AntigravityCommandV2 } {
  if (!data || typeof data !== 'object') {
    return { ok: false, error: 'Payload must be a non-null object' };
  }
  const cmd = data as Partial<AntigravityCommandV2>;
  if (cmd.protocolVersion !== 2) {
    return { ok: false, error: `Unsupported protocol version: ${cmd.protocolVersion}` };
  }
  if (typeof cmd.id !== 'string' || !/^[A-Za-z0-9_.-]{4,128}$/.test(cmd.id)) {
    return { ok: false, error: 'Invalid command ID format' };
  }
  if (!cmd.targetWorkspace || typeof cmd.targetWorkspace.folderUri !== 'string') {
    return { ok: false, error: 'Missing targetWorkspace.folderUri' };
  }
  if (cmd.action !== 'send-prompt' && cmd.action !== 'abort') {
    return { ok: false, error: `Invalid action: ${cmd.action}` };
  }
  if (cmd.mode !== 'draft' && cmd.mode !== 'auto') {
    return { ok: false, error: `Invalid mode: ${cmd.mode}` };
  }
  if (typeof cmd.promptText !== 'string') {
    return { ok: false, error: 'Missing promptText' };
  }
  if (typeof cmd.promptDigest !== 'string' || !/^[a-f0-9]{64}$/.test(cmd.promptDigest)) {
    return { ok: false, error: 'Invalid promptDigest' };
  }
  return { ok: true, command: cmd as AntigravityCommandV2 };
}

export function validateResultV2(data: unknown): { ok: boolean; error?: string; result?: AntigravityResultV2 } {
  if (!data || typeof data !== 'object') {
    return { ok: false, error: 'Result must be a non-null object' };
  }
  const res = data as Partial<AntigravityResultV2>;
  if (res.protocolVersion !== 2) {
    return { ok: false, error: `Unsupported result protocol version: ${res.protocolVersion}` };
  }
  if (typeof res.commandId !== 'string') {
    return { ok: false, error: 'Missing commandId' };
  }
  if (typeof res.hostInstanceId !== 'string') {
    return { ok: false, error: 'Missing hostInstanceId' };
  }
  if (typeof res.ok !== 'boolean') {
    return { ok: false, error: 'Missing boolean ok field' };
  }
  const validDeliveryStates: BridgeDeliveryState[] = ['queued', 'ide-api-accepted', 'failed', 'unknown'];
  if (!res.deliveryState || !validDeliveryStates.includes(res.deliveryState)) {
    return { ok: false, error: `Invalid deliveryState: ${res.deliveryState}` };
  }
  return { ok: true, result: res as AntigravityResultV2 };
}

export function validateHostV2(data: unknown): { ok: boolean; error?: string; host?: AntigravityHostV2 } {
  if (!data || typeof data !== 'object') {
    return { ok: false, error: 'Host document must be a non-null object' };
  }
  const h = data as Partial<AntigravityHostV2>;
  if (h.protocolVersion !== 2) {
    return { ok: false, error: `Unsupported host protocol version: ${h.protocolVersion}` };
  }
  if (typeof h.hostInstanceId !== 'string') {
    return { ok: false, error: 'Missing hostInstanceId' };
  }
  if (typeof h.workspaceUri !== 'string') {
    return { ok: false, error: 'Missing workspaceUri' };
  }
  if (!h.capabilities || !Array.isArray(h.capabilities.actions)) {
    return { ok: false, error: 'Invalid capabilities' };
  }
  return { ok: true, host: h as AntigravityHostV2 };
}

export class AntigravityCommandClient {
  readonly workspacePath: string;
  private readonly pollIntervalMs: number;
  private readonly defaultTimeoutMs: number;
  private readonly clock: () => number;
  private readonly fs: CommandClientFsSeam;
  private readonly activePollers = new Map<string, NodeJS.Timeout>();

  constructor(options: AntigravityCommandClientOptions) {
    if (!options.workspacePath || typeof options.workspacePath !== 'string') {
      throw new Error('AntigravityCommandClient requires an explicit, non-empty workspacePath');
    }
    this.workspacePath = path.resolve(options.workspacePath);
    this.pollIntervalMs = options.pollIntervalMs ?? 150;
    this.defaultTimeoutMs = options.timeoutMs ?? 25000;
    this.clock = options.clock ?? Date.now;
    this.fs = options.fsSeam ?? {
      existsSync: fs.existsSync,
      readFileSync: fs.readFileSync,
      writeFileSync: fs.writeFileSync,
      renameSync: fs.renameSync,
      unlinkSync: fs.unlinkSync,
      mkdirSync: fs.mkdirSync,
      readdirSync: fs.readdirSync,
      statSync: fs.statSync,
    };
  }

  getBridgeDir(): string {
    return path.join(this.workspacePath, '.antigravity', 'mcp-bridge');
  }

  getSnapshotsDir(): string {
    return path.join(this.workspacePath, '.antigravity', 'snapshots');
  }

  ensureDirectories(): void {
    const bridgeDir = this.getBridgeDir();
    const snapshotsDir = this.getSnapshotsDir();
    if (!this.fs.existsSync(bridgeDir)) {
      this.fs.mkdirSync(bridgeDir, { recursive: true });
    }
    if (!this.fs.existsSync(snapshotsDir)) {
      this.fs.mkdirSync(snapshotsDir, { recursive: true });
    }
  }

  readHostStatus(): AntigravityHostV2 | null {
    const hostFile = path.join(this.getBridgeDir(), 'host.json');
    if (!this.fs.existsSync(hostFile)) {
      return null;
    }
    try {
      const raw = this.fs.readFileSync(hostFile, 'utf8');
      const parsed = JSON.parse(raw);
      const val = validateHostV2(parsed);
      return val.ok && val.host ? val.host : null;
    } catch {
      return null;
    }
  }

  checkHostLiveness(maxStaleAgeMs = 15000): { isLive: boolean; host: AntigravityHostV2 | null; reason?: string } {
    const host = this.readHostStatus();
    if (!host) {
      return { isLive: false, host: null, reason: 'host.json not found in workspace bridge directory' };
    }
    if (host.protocolVersion !== 2) {
      return { isLive: false, host, reason: `Incompatible host protocol version: ${host.protocolVersion}` };
    }
    const ageMs = this.clock() - host.lastHeartbeatEpochMs;
    if (ageMs > maxStaleAgeMs) {
      return { isLive: false, host, reason: `Host heartbeat is stale (${Math.round(ageMs / 1000)}s old)` };
    }
    return { isLive: true, host };
  }

  cleanStaleFiles(maxAgeMs = 24 * 60 * 60 * 1000): number {
    const bridgeDir = this.getBridgeDir();
    if (!this.fs.existsSync(bridgeDir)) return 0;
    let cleaned = 0;
    const now = this.clock();
    try {
      const entries = this.fs.readdirSync(bridgeDir);
      for (const entry of entries) {
        if (entry === 'host.json') continue;
        const fullPath = path.join(bridgeDir, entry);
        try {
          const st = this.fs.statSync(fullPath);
          const ageMs = now - st.mtimeMs;
          if (entry.includes('.tmp-') && ageMs > 5 * 60 * 1000) {
            this.fs.unlinkSync(fullPath);
            cleaned++;
          } else if (ageMs > maxAgeMs) {
            this.fs.unlinkSync(fullPath);
            cleaned++;
          }
        } catch {}
      }
    } catch {}
    return cleaned;
  }

  dispatchCommand(params: DispatchCommandParams): {
    command: AntigravityCommandV2;
    resultPromise: Promise<AntigravityResultV2>;
  } {
    this.ensureDirectories();

    const now = this.clock();
    const timeoutMs = params.timeoutMs ?? this.defaultTimeoutMs;
    const expiresAt = params.expiresAtEpochMs ?? (now + timeoutMs + 10000);
    const commandId = generateCommandId();
    const digest = computePromptDigest(params.promptText);

    const command: AntigravityCommandV2 = {
      protocolVersion: 2,
      id: commandId,
      senderId: 'antifan-desktop',
      createdAtEpochMs: now,
      expiresAtEpochMs: expiresAt,
      targetWorkspace: {
        folderUri: this.workspacePath,
        folderName: path.basename(this.workspacePath),
      },
      action: params.action,
      mode: params.mode,
      promptText: params.promptText,
      promptDigest: digest,
      targetConversationId: params.targetConversationId,
      requestedRoute: params.requestedRoute,
      attachments: params.attachments,
      clientInstanceId: params.clientInstanceId,
      meta: params.meta,
    };

    const bridgeDir = this.getBridgeDir();
    const targetFile = path.join(bridgeDir, `${commandId}.json`);
    const tempFile = path.join(bridgeDir, `${commandId}.json.tmp-${Date.now()}`);

    // Atomic write
    this.fs.writeFileSync(tempFile, JSON.stringify(command, null, 2), 'utf8');
    this.fs.renameSync(tempFile, targetFile);

    const resultPromise = this.pollForResult(commandId, timeoutMs);
    return { command, resultPromise };
  }

  private pollForResult(commandId: string, timeoutMs: number): Promise<AntigravityResultV2> {
    const bridgeDir = this.getBridgeDir();
    const resultFile = path.join(bridgeDir, `${commandId}.res.json`);
    const startTime = this.clock();

    return new Promise<AntigravityResultV2>((resolve) => {
      const checkResult = () => {
        if (this.fs.existsSync(resultFile)) {
          try {
            const raw = this.fs.readFileSync(resultFile, 'utf8');
            const parsed = JSON.parse(raw);
            const val = validateResultV2(parsed);
            if (val.ok && val.result) {
              this.cleanupPoller(commandId);
              // Clean up consumed result file
              try {
                this.fs.unlinkSync(resultFile);
              } catch {
                // non-fatal
              }
              resolve(val.result);
              return;
            }
          } catch {
            // file may still be partially written, retry next tick
          }
        }

        const elapsed = this.clock() - startTime;
        if (elapsed >= timeoutMs) {
          this.cleanupPoller(commandId);
          // Timeout transition to 'unknown' without auto-retry
          const fallbackResult: AntigravityResultV2 = {
            protocolVersion: 2,
            commandId,
            hostInstanceId: 'unknown',
            hostEpoch: 0,
            targetWorkspace: { folderUri: this.workspacePath },
            ok: false,
            deliveryState: 'unknown',
            errorCode: 'TIMEOUT_WAITING_RECEIPT',
            errorMessage: `No response receipt received from extension within ${timeoutMs}ms`,
            completedAtEpochMs: this.clock(),
          };
          resolve(fallbackResult);
          return;
        }

        const timer = setTimeout(checkResult, this.pollIntervalMs);
        this.activePollers.set(commandId, timer);
      };

      const timer = setTimeout(checkResult, this.pollIntervalMs);
      this.activePollers.set(commandId, timer);
    });
  }

  cancelPending(commandId: string): void {
    this.cleanupPoller(commandId);
    const bridgeDir = this.getBridgeDir();
    const targetFile = path.join(bridgeDir, `${commandId}.json`);
    if (this.fs.existsSync(targetFile)) {
      try {
        this.fs.unlinkSync(targetFile);
      } catch {
        // ignore
      }
    }
  }

  private cleanupPoller(commandId: string): void {
    const timer = this.activePollers.get(commandId);
    if (timer) {
      clearTimeout(timer);
      this.activePollers.delete(commandId);
    }
  }

  cleanupStaleBridgeFiles(maxAgeMs = 86400000): number {
    const bridgeDir = this.getBridgeDir();
    if (!this.fs.existsSync(bridgeDir)) {
      return 0;
    }
    const now = this.clock();
    let cleaned = 0;
    try {
      const files = this.fs.readdirSync(bridgeDir);
      for (const file of files) {
        if (file === 'host.json') continue;
        const fullPath = path.join(bridgeDir, file);
        try {
          const stats = this.fs.statSync(fullPath);
          const age = now - stats.mtimeMs;
          if (age > maxAgeMs) {
            this.fs.unlinkSync(fullPath);
            cleaned++;
          }
        } catch {
          // ignore
        }
      }
    } catch {
      // ignore
    }
    return cleaned;
  }
}
