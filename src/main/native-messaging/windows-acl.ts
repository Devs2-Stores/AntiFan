import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import {
  resolveCurrentUserSid,
  hasProtectedDirectoryDacl,
  enforceProtectedDirectoryDacl,
} from '../security/windows-acl';

export { resolveCurrentUserSid, hasProtectedDirectoryDacl, enforceProtectedDirectoryDacl };

export interface RuntimeBridgeAuth {
  instanceUuid: string;
  launchNonce: string;
  socketPath: string;
  port: number;
  createdAt: number;
}

export function setupSecureRuntimeAuth(
  instanceUuid: string,
  launchNonce: string,
  port: number,
  customRuntimeDir?: string
): { runtimeDir: string; authFile: string; socketPath: string } {
  const localAppData = process.env.LOCALAPPDATA || path.join(os.homedir(), 'AppData', 'Local');
  const runtimeDir = customRuntimeDir || path.join(localAppData, 'AntiFan', 'runtime');
  const authFile = path.join(runtimeDir, 'bridge-auth.json');
  const socketPath = `\\\\.\\pipe\\antifan-bridge-ipc-${instanceUuid}`;

  if (!fs.existsSync(runtimeDir)) {
    fs.mkdirSync(runtimeDir, { recursive: true });
  }

  // Enforce explicit fail-closed DACL before writing secret nonce
  const userSid = resolveCurrentUserSid();
  enforceProtectedDirectoryDacl(runtimeDir, userSid);

  const authData: RuntimeBridgeAuth = {
    instanceUuid,
    launchNonce,
    socketPath,
    port,
    createdAt: Date.now(),
  };

  // Write nonce file inside verified protected directory
  fs.writeFileSync(authFile, JSON.stringify(authData, null, 2), 'utf8');
  return { runtimeDir, authFile, socketPath };
}
