/**
 * Chrome IPC routes audit & consistency test.
 *
 * Verifies NativeTabHost.CHROME_ROUTES:
 * 1. No duplicate channels and every channel is a non-empty string.
 * 2. Every route has at least one surface and all surfaces are in the taxonomy.
 * 3. Route-table / renderer consistency: every channel referenced in renderer/preload
 *    has its surface represented in the route's surface set.
 * 4. installChromeIpcOnce is idempotent: calling it twice with the table registers nothing
 *    the second time.
 */
import { describe, it } from 'node:test';
import * as assert from 'node:assert';
import * as fs from 'fs';
import * as path from 'path';
import { NativeTabHost } from '../../src/main/browser/native-tab-host';
import {
  installChromeIpcOnce,
  listRegisteredChromeChannels,
  type ChromeIpcRegistrar,
  type IpcRoute,
} from '../../src/main/browser/ipc-router';

const TAXONOMY: Record<string, true> = {
  toolbar: true,
  sidebar: true,
  frameBackdrop: true,
  terminalPopout: true,
  devtools: true,
  // A member page's own webContents. It has to be in the taxonomy and in the file map below,
  // or a channel a page sends can be declared for a chrome surface and never checked against
  // its real sender — which is how 'antifan:tab-wheel-zoom' and 'antifan:dom-mutation' ended up
  // declared 'toolbar' while only `src/preload/tab-preload.ts` ever sends them.
  tab: true,
};
describe('Chrome IPC Routes Table Audit', () => {
  const routes: readonly IpcRoute[] = NativeTabHost.CHROME_ROUTES;

  it('1. contains no duplicate channel, and every channel is a non-empty string', () => {
    assert.ok(Array.isArray(routes), 'NativeTabHost.CHROME_ROUTES must be an array');
    assert.ok(routes.length > 0, 'NativeTabHost.CHROME_ROUTES must not be empty');

    const seenChannels = new Set<string>();
    for (const route of routes) {
      assert.strictEqual(typeof route.channel, 'string', 'Channel must be a string');
      assert.ok(route.channel.trim().length > 0, 'Channel must not be empty');
      assert.strictEqual(
        seenChannels.has(route.channel),
        false,
        `Duplicate channel in route table: ${route.channel}`
      );
      seenChannels.add(route.channel);
    }

    assert.strictEqual(routes.length, 117, 'Route table must contain exactly 117 routes');
  });

  it('2. every route has at least one surface and every surface is in the taxonomy', () => {
    for (const route of routes) {
      const allowed = Array.isArray(route.surface) ? route.surface : [route.surface];
      assert.ok(allowed.length > 0, `Route ${route.channel} must have at least one surface`);
      for (const s of allowed) {
        assert.ok(
          TAXONOMY[s],
          `Route ${route.channel} has surface "${s}" not in taxonomy: ${Object.keys(TAXONOMY).join(', ')}`
        );
      }
    }
  });
  it('3. route-table / renderer consistency: every renderer/preload caller is permitted', () => {
    const root = fs.existsSync(path.join(process.cwd(), 'src')) ? process.cwd() : path.resolve(__dirname, '..', '..');
    const fileSurfaceMap: Record<string, string[]> = {
      'src/renderer/toolbar.html': ['toolbar'],
      'src/renderer/toolbar.ts': ['toolbar'],
      'src/preload/toolbar-preload.ts': ['toolbar'],
      'src/renderer/standalone.html': ['sidebar', 'terminalPopout'],
      'src/renderer/standalone.js': ['sidebar', 'terminalPopout'],
      'src/renderer/terminal-write-dispatcher.js': ['sidebar', 'terminalPopout'],
      'src/preload/standalone-preload.ts': ['sidebar', 'terminalPopout'],
      'src/renderer/frame-backdrop.html': ['frameBackdrop'],
      'src/renderer/frame-backdrop.ts': ['frameBackdrop'],
      'src/preload/frame-backdrop-preload.ts': ['frameBackdrop'],
      'src/preload/tab-preload.ts': ['tab'],
    };

    // Load contracts to resolve constant names to channel strings
    const contractsPath = path.join(root, 'src', 'shared', 'contracts.ts');
    const contractsText = fs.readFileSync(contractsPath, 'utf8');

    const channelIdentMap = new Map<string, string[]>(); // channel literal -> [identifier names]
    for (const match of contractsText.matchAll(/export\s+const\s+([A-Z_]+_CHANNELS)\s*=\s*\{([\s\S]*?)\}\s*as\s+const;/g)) {
      const objName = match[1] ?? '';
      const body = match[2] ?? '';
      for (const line of body.split('\n')) {
        const propMatch = line.match(/^\s*([A-Z0-9_]+)\s*:\s*['"]([^'"]+)['"]/);
        if (propMatch && propMatch[1] && propMatch[2]) {
          const fullIdent = `${objName}.${propMatch[1]}`;
          const channelVal = propMatch[2];
          const existing = channelIdentMap.get(channelVal) || [];
          existing.push(fullIdent);
          channelIdentMap.set(channelVal, existing);
        }
      }
    }

    // Map each route's surfaces
    const routeMap = new Map<string, string[]>();
    for (const r of routes) {
      const surfaces = Array.isArray(r.surface) ? [...r.surface] : [r.surface];
      routeMap.set(r.channel, surfaces);
    }

    // For each file, check every channel referenced in that file
    for (const [relPath, expectedSurfaces] of Object.entries(fileSurfaceMap)) {
      const fullPath = path.join(root, ...relPath.split('/'));
      if (!fs.existsSync(fullPath)) continue;
      const fileContent = fs.readFileSync(fullPath, 'utf8');

      for (const [channelVal, surfaces] of routeMap.entries()) {
        const idents = channelIdentMap.get(channelVal) || [];
        const hasLiteral = fileContent.includes(`'${channelVal}'`) || fileContent.includes(`"${channelVal}"`);
        const hasIdent = idents.some((id) => fileContent.includes(id));

        if (hasLiteral || hasIdent) {
          const isAllowed = expectedSurfaces.some((surf) => surfaces.includes(surf));
          assert.ok(
            isAllowed,
            `Channel ${channelVal} referenced in ${relPath} (surfaces: ${expectedSurfaces.join(',')}) but route allows [${surfaces.join(',')}]`
          );
        }
      }
    }
  });

  it('4. installChromeIpcOnce is idempotent: second call registers nothing', () => {
    let handleRegistrations = 0;
    let onRegistrations = 0;
    const fakeRegistrar: ChromeIpcRegistrar = {
      handle: () => { handleRegistrations++; },
      on: () => { onRegistrations++; },
    };

    const initialChannels = listRegisteredChromeChannels();

    // Call once
    installChromeIpcOnce(routes, fakeRegistrar);
    const countAfterFirst = handleRegistrations + onRegistrations;
    const channelsAfterFirst = listRegisteredChromeChannels();

    // Call second time
    installChromeIpcOnce(routes, fakeRegistrar);
    const countAfterSecond = handleRegistrations + onRegistrations;
    const channelsAfterSecond = listRegisteredChromeChannels();

    // Idempotency: second call registers nothing
    assert.strictEqual(
      countAfterSecond,
      countAfterFirst,
      'Second installChromeIpcOnce call must not register any additional handlers'
    );
    assert.strictEqual(
      channelsAfterSecond.length,
      channelsAfterFirst.length,
      'Registered chrome channels list length must remain stable on second call'
    );

    // If this test ran in a fresh process, countAfterFirst == routes.length,
    // otherwise if a prior test installed them, countAfterFirst is 0. Either way,
    // countAfterSecond === countAfterFirst proves idempotency.
    if (initialChannels.length === 0) {
      assert.strictEqual(countAfterFirst, routes.length, 'First install must register all routes');
    }
  });
});
