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
 * 5. Preload transport consistency: every `ipcRenderer.invoke`/`send`/`on` call site in
 *    `src/preload/*.ts` uses the transport its channel actually has. `invoke` must land
 *    on a `kind:'handle'` receiver, `send` on a `kind:'on'` receiver, and `on` must
 *    listen on a declared push channel that is not a registered route. A preload member
 *    that invokes a channel nobody receives — or subscribes on a request channel —
 *    fails here even though the route-table-only checks above cannot see it.
 */
import { describe, it } from 'node:test';
import * as assert from 'node:assert';
import * as fs from 'fs';
import * as path from 'path';

import { installElectronStub } from '../support/electron-stub';

// The stub must be in the require cache before src/main/index is loaded: the module
// registers its privileged schemes and reads app paths at import time, which no plain
// node run can serve.
installElectronStub();

import { NativeTabHost } from '../../src/main/browser/native-tab-host';
import { PROJECT_WINDOW_ROUTES } from '../../src/main/index';
import {
  BRIDGE_CHANNELS,
  FRAME_BACKDROP_CHANNELS,
  PROJECT_WINDOW_CHANNELS,
  TERMINAL_CHANNELS,
  TOOLBAR_CHANNELS,
} from '../../src/shared/contracts';
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

    assert.strictEqual(routes.length, 124, 'Route table must contain exactly 124 routes');
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
      assert.ok(fs.existsSync(fullPath), `Audited file ${relPath} must exist at ${fullPath}`);
      const fileContent = fs.readFileSync(fullPath, 'utf8');
      // Strip comments so references in comments are not treated as active call sites
      const cleanContent = fileContent.replace(/\/\*[\s\S]*?\*\/|\/\/.*/g, '');

      for (const [channelVal, surfaces] of routeMap.entries()) {
        const idents = channelIdentMap.get(channelVal) || [];
        const hasLiteral = cleanContent.includes(`'${channelVal}'`) || cleanContent.includes(`"${channelVal}"`);
        const hasIdent = idents.some((id) => {
          const escaped = id.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
          const callSitePattern = new RegExp(`\\bipcRenderer\\s*\\.\\s*(?:invoke|send|sendSync|on|once|removeListener|postMessage)\\s*\\([^;\\n)]*\\b${escaped}\\b`);
          return callSitePattern.test(cleanContent);
        });

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

  it('5. preload transport consistency: every ipcRenderer call uses the transport its channel has', () => {
    const root = fs.existsSync(path.join(process.cwd(), 'src')) ? process.cwd() : path.resolve(__dirname, '..', '..');

    // Every channel Main installs through the router: the host's table plus the
    // cross-window entries src/main/index unions in at install time. kind defaults
    // to 'handle' when a route does not say otherwise, mirroring installChromeIpcOnce.
    const routeKindByChannel = new Map<string, 'handle' | 'on'>();
    for (const route of [...routes, ...PROJECT_WINDOW_ROUTES]) {
      routeKindByChannel.set(route.channel, route.kind ?? 'handle');
    }

    // Receivers that bypass the route table (the vaults register their own ipcMain
    // handlers). A preload member invoking one of these is wired, not a route-table gap.
    const directReceivers = new Map<string, 'handle' | 'on'>();
    const mainSourceFiles: string[] = [];
    const walkMain = (dir: string): void => {
      for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) walkMain(full);
        else if (entry.name.endsWith('.ts')) mainSourceFiles.push(full);
      }
    };
    walkMain(path.join(root, 'src', 'main'));
    for (const file of mainSourceFiles) {
      const text = fs.readFileSync(file, 'utf8');
      for (const match of text.matchAll(/\bipcMain\s*\.\s*(handle|handleOnce|on|once)\s*\(\s*['"]([^'"]+)['"]/g)) {
        directReceivers.set(match[2] ?? '', (match[1] ?? '').startsWith('handle') ? 'handle' : 'on');
      }
      // The credential vault registers through an injectable `ipc` facade that is
      // ipcMain in production; its channels use the same one-argument literal form.
      for (const match of text.matchAll(/\bthis\.ipc\s*\.\s*(handle|on)\s*\(\s*['"]([^'"]+)['"]/g)) {
        directReceivers.set(match[2] ?? '', match[1] === 'handle' ? 'handle' : 'on');
      }
    }

    // The push channels a preload may legitimately listen on: channels Main sends to a
    // webContents and never installs as a route, named through the contract constants
    // (or literals) the call sites actually use. A channel in neither this set nor the
    // route table fails the listener check — subscribing to a request channel, or to a
    // channel nobody produces, is the mutation this audit exists to catch.
    const pushChannels = new Set<string>([
      BRIDGE_CHANNELS.STATUS_CHANGED,
      PROJECT_WINDOW_CHANNELS.PROJECT_OPEN_PICKER,
      PROJECT_WINDOW_CHANNELS.CLOSE_REFUSED,
      FRAME_BACKDROP_CHANNELS.UPDATE_LAYOUT,
      TERMINAL_CHANNELS.DATA,
      TERMINAL_CHANNELS.RUN_STATE,
      TERMINAL_CHANNELS.POPOUT_STATE_CHANGED,
      TERMINAL_CHANNELS.ACTIVITY,
      'antifan:terminal:session',
      'antifan:workflow:event',
      'antifan:focus-find',
      'antifan:focus-omnibox',
      'antifan:show-shortcuts',
      'antifan:screenshot-captured',
      TOOLBAR_CHANNELS.STATE_UPDATED,
      TOOLBAR_CHANNELS.ELEMENT_PICKED,
      TOOLBAR_CHANNELS.FIND_RESULT,
      TOOLBAR_CHANNELS.PHONE_STATUS,
      TOOLBAR_CHANNELS.THEME_QA_STATE,
    ]);

    // Resolve CONSTANT.member call-site arguments to channel literals from the
    // declared contract objects.
    const contractsText = fs.readFileSync(path.join(root, 'src', 'shared', 'contracts.ts'), 'utf8');
    const identToChannel = new Map<string, string>();
    for (const match of contractsText.matchAll(/export\s+const\s+([A-Z_]+_CHANNELS)\s*=\s*\{([\s\S]*?)\}\s*(?:as\s+const)?;/g)) {
      const objName = match[1] ?? '';
      for (const line of (match[2] ?? '').split('\n')) {
        const propMatch = line.match(/^\s*([A-Z0-9_]+)\s*:\s*['"]([^'"]+)['"]/);
        if (propMatch && propMatch[1] && propMatch[2]) {
          identToChannel.set(`${objName}.${propMatch[1]}`, propMatch[2]);
        }
      }
    }

    const preloadDir = path.join(root, 'src', 'preload');
    const preloadFiles = fs.readdirSync(preloadDir).filter((name) => name.endsWith('.ts')).sort();
    assert.ok(preloadFiles.length > 0, 'src/preload must contain preload scripts to audit');

    const failures: string[] = [];
    for (const fileName of preloadFiles) {
      const relPath = `src/preload/${fileName}`;
      const fileContent = fs.readFileSync(path.join(preloadDir, fileName), 'utf8');
      // Strip comments so commented-out calls are not audited as live call sites.
      const cleanContent = fileContent.replace(/\/\*[\s\S]*?\*\/|\/\/.*/g, '');

      // A file-local channel object (toolbar-preload's CHANNELS) resolves like the
      // contract objects; merge it over the shared map for this file only.
      const fileIdentToChannel = new Map(identToChannel);
      for (const match of cleanContent.matchAll(/\bconst\s+([A-Z_]+)\s*=\s*\{([\s\S]*?)\}\s*(?:as\s+const)?;/g)) {
        const objName = match[1] ?? '';
        for (const line of (match[2] ?? '').split('\n')) {
          const propMatch = line.match(/^\s*([A-Z0-9_]+)\s*:\s*['"]([^'"]+)['"]/);
          if (propMatch && propMatch[1] && propMatch[2]) {
            fileIdentToChannel.set(`${objName}.${propMatch[1]}`, propMatch[2]);
          }
        }
      }

      // Member attribution: the api-object key nearest above the call site names the
      // exposed member a renderer would call (module scope for bare sends).
      const memberPositions: Array<{ name: string; at: number }> = [];
      for (const match of cleanContent.matchAll(/^\s{2,4}([A-Za-z_$][\w$]*)\s*:/gm)) {
        memberPositions.push({ name: match[1] ?? '', at: match.index ?? 0 });
      }
      const memberFor = (index: number): string => {
        let name = '(module scope)';
        for (const member of memberPositions) {
          if (member.at < index) name = member.name;
          else break;
        }
        return name;
      };

      const callSitePattern = /\bipcRenderer\s*\.\s*(invoke|send|sendSync|on|once|postMessage)\s*\(\s*([^,\n)]+)/g;
      for (const match of cleanContent.matchAll(callSitePattern)) {
        const method = match[1] ?? '';
        const firstArg = (match[2] ?? '').trim();
        const member = memberFor(match.index ?? 0);

        let channel: string | undefined;
        const literal = firstArg.match(/^['"`]([^'"`]+)['"`]/);
        if (literal) {
          channel = literal[1];
        } else {
          const ident = firstArg.match(/^([A-Za-z_$][\w$]*\.[A-Z0-9_]+)/);
          if (ident && ident[1]) channel = fileIdentToChannel.get(ident[1]);
        }
        if (!channel) {
          failures.push(`${relPath} → ${member}: ${method}(${firstArg.slice(0, 60)}) — channel argument is not a literal and does not resolve to a declared channel constant`);
          continue;
        }

        const routedKind = routeKindByChannel.get(channel);
        const directKind = directReceivers.get(channel);
        if (method === 'invoke') {
          if (routedKind !== undefined && routedKind !== 'handle') {
            failures.push(`${relPath} → ${member} → invoke('${channel}'): expected kind:'handle' route, found kind:'${routedKind}'`);
          } else if (routedKind === undefined && directKind === undefined) {
            failures.push(`${relPath} → ${member} → invoke('${channel}'): expected a registered receiver, found none (not in route table, no ipcMain.handle)`);
          } else if (routedKind === undefined && directKind !== 'handle') {
            failures.push(`${relPath} → ${member} → invoke('${channel}'): expected an ipcMain.handle receiver, found ipcMain.${directKind ?? '?'}`);
          }
        } else if (method === 'send' || method === 'sendSync' || method === 'postMessage') {
          if (routedKind !== undefined && routedKind !== 'on') {
            failures.push(`${relPath} → ${member} → ${method}('${channel}'): expected kind:'on' route, found kind:'${routedKind}'`);
          } else if (routedKind === undefined && directKind === undefined) {
            failures.push(`${relPath} → ${member} → ${method}('${channel}'): expected a registered receiver, found none (not in route table, no ipcMain.on)`);
          } else if (routedKind === undefined && directKind !== 'on') {
            failures.push(`${relPath} → ${member} → ${method}('${channel}'): expected an ipcMain.on receiver, found ipcMain.${directKind ?? '?'}`);
          }
        } else {
          // on / once: legal only on a channel Main pushes on. A registered route is a
          // request channel — the sender is answered or refused, never broadcast back
          // on the same channel — so listening on one is a dead subscription.
          if (routedKind !== undefined) {
            failures.push(`${relPath} → ${member} → ${method}('${channel}'): expected a declared push channel, found a registered kind:'${routedKind}' route`);
          } else if (!pushChannels.has(channel)) {
            failures.push(`${relPath} → ${member} → ${method}('${channel}'): expected a declared push channel or a route, found neither`);
          }
        }
      }
    }

    assert.deepStrictEqual(
      failures,
      [],
      `Preload IPC call sites disagree with the route table / push contract:\n  ${failures.join('\n  ')}`
    );
  });
});
