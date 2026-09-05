import * as net from 'net';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { NativeMessageDecoder, encodeNativeMessage } from './framing';
import { RuntimeBridgeAuth } from './windows-acl';

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

  constructor(customRuntimeDir?: string) {
    this.customRuntimeDir = customRuntimeDir;
  }

  public async connect(): Promise<net.Socket> {
    if (this.socket && !this.socket.destroyed) {
      return this.socket;
    }

    const auth = readRuntimeAuthFile(this.customRuntimeDir);
    if (!auth || !auth.socketPath) {
      throw new Error('AntiFan Desktop is not running (no active runtime auth file found).');
    }

    return new Promise((resolve, reject) => {
      const socket = net.createConnection(auth.socketPath, () => {
        this.socket = socket;
        this.decoder = new NativeMessageDecoder();
        socket.pipe(this.decoder);
        resolve(socket);
      });

      socket.on('error', (err) => {
        reject(new Error(`Failed to connect to AntiFan Local IPC at ${auth.socketPath}: ${err.message}`));
      });
    });
  }

  public async send(message: any): Promise<any> {
    const socket = await this.connect();
    const auth = readRuntimeAuthFile(this.customRuntimeDir);
    const payload = { ...message };
    if (payload.action === 'HANDSHAKE' && !payload.launchNonce && auth?.launchNonce) {
      payload.launchNonce = auth.launchNonce;
    }

    return new Promise((resolve, reject) => {
      if (!this.decoder) {
        return reject(new Error('Decoder not initialized.'));
      }

      const onData = (response: any) => {
        cleanup();
        resolve(response);
      };

      const onError = (err: Error) => {
        cleanup();
        reject(err);
      };

      const onClose = () => {
        cleanup();
        reject(new Error('IPC socket closed before receiving response.'));
      };

      const cleanup = () => {
        this.decoder?.removeListener('data', onData);
        this.decoder?.removeListener('error', onError);
        socket.removeListener('error', onError);
        socket.removeListener('close', onClose);
      };

      this.decoder.once('data', onData);
      this.decoder.once('error', onError);
      socket.once('error', onError);
      socket.once('close', onClose);

      try {
        const encoded = encodeNativeMessage(payload);
        socket.write(encoded);
      } catch (err) {
        cleanup();
        reject(err);
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
