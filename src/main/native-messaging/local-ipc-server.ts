import * as net from 'net';
import * as crypto from 'crypto';
import { NativeMessageDecoder, encodeNativeMessage } from './framing';
import {
  prepareSecureRuntimeDirectory,
  writeRuntimeAuthFile,
  removeRuntimeAuthFile,
  acquireRuntimeOwnershipLock,
  releaseRuntimeOwnershipLock
} from './windows-acl';
import { readRuntimeAuthFile } from './local-ipc-client';
import { StorageLocations } from '../config/storage-locations';

export interface HandshakeResponse {
  token: string;
  port: number;
  activeCapsuleId?: string;
  activePartition?: string;
}

export class LocalIpcServer {
  private server: net.Server | null = null;
  private instanceUuid = crypto.randomUUID();
  private launchNonce = crypto.randomBytes(32).toString('hex');
  private socketPath = '';
  private runtimeDir = '';
  private isRunning = false;
  private heartbeatTimer: NodeJS.Timeout | null = null;

  public getInstanceUuid(): string {
    return this.instanceUuid;
  }

  public getLaunchNonce(): string {
    return this.launchNonce;
  }

  public getSocketPath(): string {
    return this.socketPath;
  }

  public start(
    bridgePort: number,
    onHandshakeRequest: () => HandshakeResponse,
    customRuntimeDir?: string
  ): Promise<{ socketPath: string; instanceUuid: string }> {
    return new Promise((resolve, reject) => {
      try {
        this.runtimeDir = customRuntimeDir || StorageLocations.getRuntimeDir();
        prepareSecureRuntimeDirectory(this.runtimeDir);

        // Enforce exclusive single-owner invariant via atomic lock acquisition
        const lockRes = acquireRuntimeOwnershipLock(this.instanceUuid, this.runtimeDir);
        if (!lockRes.acquired) {
          reject(new Error(`[LocalIpcServer] Runtime ownership conflict: Live process PID ${lockRes.currentOwner?.pid} currently owns ${this.runtimeDir}`));
          return;
        }
        this.socketPath = `\\\\.\\pipe\\antifan-bridge-ipc-${this.instanceUuid}`;
        this.server = net.createServer((socket) => {
          const decoder = new NativeMessageDecoder();
          socket.pipe(decoder);

          decoder.on('data', (req: any) => {
            try {
              if (req && req.action === 'HANDSHAKE') {
                if (req.launchNonce !== this.launchNonce) {
                  const errBuf = encodeNativeMessage({
                    status: 'ERROR',
                    error: 'INVALID_LAUNCH_NONCE',
                    message: 'Supplied launch nonce does not match active instance.',
                  });
                  socket.write(errBuf);
                  socket.destroy();
                  return;
                }

                const credentials = onHandshakeRequest();
                const response = {
                  status: 'SUCCESS',
                  token: credentials.token,
                  port: credentials.port,
                  activeCapsuleId: credentials.activeCapsuleId,
                  activePartition: credentials.activePartition,
                };
                socket.write(encodeNativeMessage(response));
              } else if (req && req.action === 'PING') {
                socket.write(encodeNativeMessage({ status: 'PONG', timestamp: Date.now() }));
              } else {
                socket.write(
                  encodeNativeMessage({
                    status: 'ERROR',
                    error: 'UNSUPPORTED_ACTION',
                    message: `Action "${req?.action}" is not supported over Local IPC.`,
                  })
                );
              }
            } catch (err) {
              socket.write(
                encodeNativeMessage({
                  status: 'ERROR',
                  error: 'INTERNAL_ERROR',
                  message: (err as Error).message,
                })
              );
            }
          });

          decoder.on('error', (err) => {
            try {
              socket.write(
                encodeNativeMessage({
                  status: 'ERROR',
                  error: 'FRAMING_ERROR',
                  message: err.message,
                })
              );
              socket.destroy();
            } catch {}
          });
        });
        const cleanupAndReject = (err: any) => {
          this.isRunning = false;
          if (this.server) {
            try { this.server.close(); } catch {}
            this.server = null;
          }
          if (this.runtimeDir && this.instanceUuid) {
            removeRuntimeAuthFile(this.instanceUuid, this.runtimeDir);
            releaseRuntimeOwnershipLock(this.instanceUuid, this.runtimeDir);
          }
          reject(err);
        };

        this.server.listen(this.socketPath, () => {
          try {
            writeRuntimeAuthFile({
              instanceUuid: this.instanceUuid,
              launchNonce: this.launchNonce,
              socketPath: this.socketPath,
              port: bridgePort,
              pid: process.pid,
              createdAt: Date.now(),
            }, this.runtimeDir);

            this.isRunning = true;
            this.startHeartbeat(bridgePort);
            resolve({ socketPath: this.socketPath, instanceUuid: this.instanceUuid });
          } catch (writeErr) {
            cleanupAndReject(writeErr);
          }
        });

        this.server.on('error', (err) => {
          cleanupAndReject(err);
        });
      } catch (err) {
        if (this.runtimeDir && this.instanceUuid) {
          removeRuntimeAuthFile(this.instanceUuid, this.runtimeDir);
          releaseRuntimeOwnershipLock(this.instanceUuid, this.runtimeDir);
        }
        reject(err);
      }
    });
  }

  private startHeartbeat(bridgePort: number): void {
    if (this.heartbeatTimer) clearInterval(this.heartbeatTimer);
    this.heartbeatTimer = setInterval(() => {
      this.checkAndRepairAuthFile(bridgePort);
    }, 5000);
    this.heartbeatTimer.unref();
  }

  public checkAndRepairAuthFile(bridgePort: number): void {
    if (!this.isRunning || !this.runtimeDir) return;
    try {
      const existingAuth = readRuntimeAuthFile(this.runtimeDir);
      if (!existingAuth || existingAuth.instanceUuid !== this.instanceUuid) {
        const lockRes = acquireRuntimeOwnershipLock(this.instanceUuid, this.runtimeDir);
        if (lockRes.acquired) {
          writeRuntimeAuthFile({
            instanceUuid: this.instanceUuid,
            launchNonce: this.launchNonce,
            socketPath: this.socketPath,
            port: bridgePort,
            pid: process.pid,
            createdAt: Date.now(),
          }, this.runtimeDir);
          console.log(`[LocalIpcServer] Self-healed bridge-auth.json to active instance ${this.instanceUuid} (PID ${process.pid})`);
        }
      }
    } catch {}
  }

  public close(): void {
    if (this.heartbeatTimer) {
      clearInterval(this.heartbeatTimer);
      this.heartbeatTimer = null;
    }
    if (this.runtimeDir && this.instanceUuid) {
      removeRuntimeAuthFile(this.instanceUuid, this.runtimeDir);
      releaseRuntimeOwnershipLock(this.instanceUuid, this.runtimeDir);
    }
    if (this.server) {
      this.server.close();
      this.server = null;
      this.isRunning = false;
    }
  }
}
