import { createRequire } from 'node:module';
import fs from 'node:fs';
import path from 'node:path';

const require = createRequire(import.meta.url);
const { IosDeviceAdapter } = require('../.compiled/src/main/device/ios-device-adapter.js');
const { DeviceManager } = require('../.compiled/src/main/device/device-manager.js');
const { makeControlPlaneId } = require('../.compiled/src/shared/control-plane-contracts.js');

async function runHotspotTest() {
  const manager = new DeviceManager({
    projectId: makeControlPlaneId('project'),
    workspaceId: makeControlPlaneId('workspace'),
    runtimeId: makeControlPlaneId('runtime')
  });

  const pagePath = path.resolve('plans/reports/real-iphone-hotspot-proof.png');
  const drawerPath = path.resolve('plans/reports/real-iphone-drawer-proof.png');

  let currentOutPath = pagePath;
  const artifacts = {
    async stage(input) {
      fs.writeFileSync(currentOutPath, input.data);
      console.log('✓ Stage callback wrote:', currentOutPath, 'Bytes:', input.data.length);
      return { id: 'art-' + Date.now(), kind: 'screenshot', mime: 'image/png', bytes: input.data.length };
    }
  };

  const adapter = new IosDeviceAdapter({
    devices: manager,
    artifacts,
    allowBridge: true,
    wdaDevicePort: 8100
  });

  console.log('[1/4] Binding Safari session on real iPhone...');
  const target = await adapter.openSafari('', { initialUrl: 'http://172.20.10.2:3300/index.html' });
  console.log('[1/4] Session established:', target.sessionId);

  console.log('[2/4] Navigating directly to USB Ethernet IP http://172.20.10.2:3300/index.html...');
  await adapter.navigate(target, 'http://172.20.10.2:3300/index.html');
  console.log('[2/4] Waiting 4 seconds for page settlement...');
  await new Promise(r => setTimeout(r, 4000));

  const context = {
    runId: makeControlPlaneId('run'),
    attemptId: makeControlPlaneId('attempt'),
    projectId: target.projectId,
    workspaceId: target.workspaceId
  };

  console.log('[2/4] Capturing direct USB screenshot...');
  currentOutPath = pagePath;
  await adapter.screenshot(target, context);

  console.log('[3/4] Tapping category menu icon at x: 35, y: 130 pt...');
  await adapter.tap(target, { x: 35, y: 130 });
  console.log('[3/4] Waiting 1.5 seconds for drawer animation...');
  await new Promise(r => setTimeout(r, 1500));

  console.log('[4/4] Capturing drawer open screenshot...');
  currentOutPath = drawerPath;
  await adapter.screenshot(target, context);

  console.log('\n======================================================');
  console.log('USB ETHERNET DIRECT TEST COMPLETED!');
  console.log('Page proof:', pagePath, 'Bytes:', fs.statSync(pagePath).size);
  console.log('Drawer proof:', drawerPath, 'Bytes:', fs.statSync(drawerPath).size);
  console.log('======================================================');
}

runHotspotTest().catch(err => {
  console.error('USB Hotspot Test Error:', err);
  process.exitCode = 1;
});
