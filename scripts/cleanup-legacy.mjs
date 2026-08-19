import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');

const filesToRemove = [
  'src/main/native-tab-host.ts',
  'src/main/security-policy.ts',
  'forge.config.ts',
  'src/main/browser/browser-control-service.ts',
  'src/main/browser/console-observer.ts',
  'src/main/browser/device-manager.ts',
  'src/main/browser/navigation-policy.ts',
  'src/main/browser/network-observer.ts',
  'src/main/browser/playwright-engine.ts',
  'src/main/browser/scripts',
  'src/main/browser/session-manager.ts',
  'src/main/browser/tab-controller.ts',
  'src/main/browser/tab-manager.ts',
  'src/main/mcp/agent-mcp-server.ts',
  'src/main/mcp/live-browser-service.ts',
  'src/main/mcp/mcp-child.ts',
  'src/main/mcp/mcp-tool-contract.ts',
  'src/main/mcp/node-reference-store.ts',
  'src/main/mcp/relay-descriptor.ts',
  'src/main/mcp/tool-schema.ts',
];

for (const rel of filesToRemove) {
  const target = path.join(ROOT, rel);
  if (fs.existsSync(target)) {
    fs.rmSync(target, { recursive: true, force: true });
    console.log(`[cleanup] Removed: ${rel}`);
  }
}
