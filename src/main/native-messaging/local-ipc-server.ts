import * as net from 'net';
import * as crypto from 'crypto';
import { NativeMessageDecoder, encodeNativeMessage } from './framing';
import { setupSecureRuntimeAuth } from './windows-acl';

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
  private isRunning = false;

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
        const { socketPath } = setupSecureRuntimeAuth(
          this.instanceUuid,
          this.launchNonce,
          bridgePort,
          customRuntimeDir
        );
        this.socketPath = socketPath;

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

        this.server.listen(this.socketPath, () => {
          this.isRunning = true;
          resolve({ socketPath: this.socketPath, instanceUuid: this.instanceUuid });
        });

        this.server.on('error', (err) => {
          this.isRunning = false;
          reject(err);
        });
      } catch (err) {
        reject(err);
      }
    });
  }

  public close(): void {
    if (this.server) {
      this.server.close();
      this.server = null;
      this.isRunning = false;
    }
  }
}
