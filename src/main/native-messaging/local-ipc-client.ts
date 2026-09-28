import * as net from 'net';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { NativeMessageDecoder, encodeNativeMessage } from './framing';
import { RuntimeBridgeAuth } from './windows-acl';

/**
 * How long a Local IPC request may wait for a response from the peer.
 *
 * Far above the measured 1-15ms round trip of local named pipe / socket IPC,
 * so legitimate requests under load or slow CPU conditions are never cut short,
 * and far below a user's patience, so a hung or wedged Desktop IPC server
 * terminates in a typed failure that the host runner can report and recover from
 * rather than hanging the Chromium native messaging channel indefinitely.
 */
export const LOCAL_IPC_RESPONSE_DEADLINE_MS = 5_000;

/** Raised when the Local IPC peer does not respond within the allocated deadline. */
export class LocalIpcTimeoutError extends Error {
  public readonly code = 'LOCAL_IPC_TIMEOUT';

  constructor(message: string = `Local IPC peer did not answer within ${LOCAL_IPC_RESPONSE_DEADLINE_MS}ms deadline.`) {
    super(message);
    this.name = 'LocalIpcTimeoutError';
  }
}

/** Raised when the Local IPC socket closes or is destroyed before a response is received. */
export class LocalIpcClosedError extends Error {
  public readonly code = 'LOCAL_IPC_CLOSED';

  constructor(message: string = 'IPC socket closed before receiving response.') {
    super(message);
    this.name = 'LocalIpcClosedError';
  }
}

export interface LocalIpcClientOptions {
  customRuntimeDir?: string;
  socket?: net.Socket;
  responseDeadlineMs?: number;
}

export function readRuntimeAuthFile(customRuntimeDir?: string): RuntimeBridgeAuth | null {
  const localAppData = process.env.LOCALAPPDATA || path.join(os.homedir(), 'AppData', 'Local');
  const runtimeDir = customRuntimeDir || path.join(localAppData, 'AntiFan', 'runtime');
  const authFile = path.join(runtimeDir, 'bridge-auth.json');

  if (!fs.existsSync(authFile)) {
    return null;
  }

  try {
    const raw = fs.readFileSync(authFile, 'utf8');
    return JSON.parse(raw) as RuntimeBridgeAuth;
  } catch {
    return null;
  }
}

export class LocalIpcClient {
  private socket: net.Socket | null = null;
  private decoder: NativeMessageDecoder | null = null;
  private customRuntimeDir?: string;
  private responseDeadlineMs: number;

  constructor(customRuntimeDirOrOptions?: string | LocalIpcClientOptions) {
    if (typeof customRuntimeDirOrOptions === 'string') {
      this.customRuntimeDir = customRuntimeDirOrOptions;
      this.responseDeadlineMs = LOCAL_IPC_RESPONSE_DEADLINE_MS;
    } else if (customRuntimeDirOrOptions) {
      this.customRuntimeDir = customRuntimeDirOrOptions.customRuntimeDir;
      this.responseDeadlineMs = customRuntimeDirOrOptions.responseDeadlineMs ?? LOCAL_IPC_RESPONSE_DEADLINE_MS;
      if (customRuntimeDirOrOptions.socket) {
        this.attachSocket(customRuntimeDirOrOptions.socket);
      }
    } else {
      this.responseDeadlineMs = LOCAL_IPC_RESPONSE_DEADLINE_MS;
    }
  }

  public attachSocket(socket: net.Socket): void {
    this.socket = socket;
    this.decoder = new NativeMessageDecoder();
    socket.pipe(this.decoder);
    // Ensure stream errors remain observed and do not crash on late events
    socket.on('error', () => {});
    this.decoder.on('error', () => {});
  }

  public async connect(): Promise<net.Socket> {
    if (this.socket && !this.socket.destroyed) {
      if (!this.decoder) {
        this.decoder = new NativeMessageDecoder();
        this.socket.pipe(this.decoder);
        this.decoder.on('error', () => {});
      }
      return this.socket;
    }

    const auth = readRuntimeAuthFile(this.customRuntimeDir);
    if (!auth || !auth.socketPath) {
      if (this.socket?.destroyed) {
        throw new LocalIpcClosedError('IPC socket closed before receiving response.');
      }
      throw new Error('AntiFan Desktop is not running (no active runtime auth file found).');
    }

    return new Promise((resolve, reject) => {
      const socket = net.createConnection(auth.socketPath, () => {
        this.socket = socket;
        this.decoder = new NativeMessageDecoder();
        socket.pipe(this.decoder);
        socket.on('error', () => {});
        this.decoder.on('error', () => {});
        resolve(socket);
      });

      socket.once('error', (err) => {
        reject(new Error(`Failed to connect to AntiFan Local IPC at ${auth.socketPath}: ${err.message}`));
      });
    });
  }

  // Framing protocol exchanges arbitrary JSON message records
  public async send<T = any>(message: unknown, timeoutMs?: number): Promise<T> {
    if (this.socket && this.socket.destroyed) {
      throw new LocalIpcClosedError('IPC socket closed before receiving response.');
    }

    const socket = await this.connect();
    const auth = readRuntimeAuthFile(this.customRuntimeDir);
    const payload: Record<string, unknown> = (typeof message === 'object' && message !== null)
      ? { ...(message as Record<string, unknown>) }
      : { message };

    if (payload.action === 'HANDSHAKE' && !payload.launchNonce && auth?.launchNonce) {
      payload.launchNonce = auth.launchNonce;
    }

    // A dead port is a fact, not a silence: settle immediately if already destroyed or unwritable.
    if (socket.destroyed || !socket.writable) {
      throw new LocalIpcClosedError('IPC socket closed before receiving response.');
    }

    const boundMs = Math.max(1, timeoutMs ?? this.responseDeadlineMs);

    return new Promise<T>((resolve, reject) => {
      if (!this.decoder || this.decoder.destroyed) {
        return reject(new LocalIpcClosedError('Decoder not initialized or destroyed.'));
      }

      let settled = false;
      let outcomeTimer: NodeJS.Timeout | null = null;

      const cleanup = () => {
        if (outcomeTimer) {
          clearTimeout(outcomeTimer);
          outcomeTimer = null;
        }
        this.decoder?.removeListener('data', onData);
        this.decoder?.removeListener('error', onError);
        socket.removeListener('error', onError);
        socket.removeListener('close', onClose);
        socket.removeListener('end', onClose);
      };

      const finish = (err: Error | null, response?: T) => {
        if (settled) return;
        settled = true;
        cleanup();
        if (err) {
          reject(err);
        } else {
          resolve(response as T);
        }
      };

      const onData = (response: T) => {
        finish(null, response);
      };

      const onError = (err: Error) => {
        finish(err);
      };

      const onClose = () => {
        finish(new LocalIpcClosedError('IPC socket closed before receiving response.'));
      };

      // Armed before waiting/writing: a peer that swallows the call or stalls
      // emits no event at all, so an un-armed wait would hang forever.
      outcomeTimer = setTimeout(() => {
        finish(new LocalIpcTimeoutError(`Local IPC peer did not answer within ${boundMs}ms deadline.`));
      }, boundMs);
      if (typeof outcomeTimer.unref === 'function') {
        outcomeTimer.unref();
      }

      this.decoder.once('data', onData);
      this.decoder.once('error', onError);
      socket.once('error', onError);
      socket.once('close', onClose);
      socket.once('end', onClose);

      // Re-verify port health after arming listeners in case an event raced
      if (socket.destroyed || !socket.writable) {
        finish(new LocalIpcClosedError('IPC socket closed before receiving response.'));
        return;
      }

      try {
        const encoded = encodeNativeMessage(payload);
        socket.write(encoded, (err) => {
          if (err) {
            finish(err);
          }
        });
      } catch (err) {
        finish(err instanceof Error ? err : new Error(String(err)));
      }
    });
  }

  public disconnect(): void {
    if (this.socket) {
      this.socket.destroy();
      this.socket = null;
      this.decoder = null;
    }
  }
}
