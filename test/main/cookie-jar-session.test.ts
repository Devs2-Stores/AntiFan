/**
 * Named cookie jars: the half of the contract that touches sessions, the disk and restore.
 *
 * - the session registry tells a jar apart from a profile, a capsule and an ephemeral
 *   session, so credential routes (Session Vault, bridge cookie import, partition-addressed
 *   grants) can refuse it;
 * - the dead-store cleaner and the legacy capsule migration leave `persist:jar-*` alone, on
 *   a real temporary tree;
 * - restore re-opens a saved tab in the jar it was saved in, driven through the real
 *   `restoreTabs()` with the allocation step recorded.
 *
 * The argument check, the derivation and the schema live in cookie-jar.test.ts.
 */
import { describe, it, before } from 'node:test';
import * as assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import type * as PartitionModule from '../../src/main/browser/browser-session-partition';
import type * as HostModule from '../../src/main/browser/native-tab-host';
import { isDeadPartitionName, pruneDeadStores } from '../../src/main/browser/dead-store-cleaner';
import { runCapsuleToProfileMigration } from '../../src/main/browser/capsule-partition-migration';
import { deriveCookieJarPartition } from '../../src/main/browser/cookie-jar';
import { ownerKey } from '../../src/main/browser/project-window-shell';
import { sanitizeTabForPersistence } from '../../src/main/browser/split-review-coordinator';
import type { AntiFanTab } from '../../src/shared/contracts';

const ELECTRON_UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) AntiFan/1.0.0 Electron/43.4.0 Chrome/140.0.0.0 Safari/537.36';

interface FakeSession {
  readonly partition: string;
  getUserAgent(): string;
  setUserAgent(ua: string): void;
  cookies: { on(event: string, listener: () => void): void; flushStore(): Promise<void> };
  webRequest: { onBeforeSendHeaders(filter: unknown, handler: unknown): void };
}

const sessionsByPartition = new Map<string, FakeSession>();

function makeFakeSession(partition: string): FakeSession {
  return {
    partition,
    getUserAgent: () => ELECTRON_UA,
    setUserAgent: () => {},
    cookies: { on: () => {}, flushStore: async () => {} },
    webRequest: { onBeforeSendHeaders: () => {} },
  };
}

/** Same seam partition-selection-invariance.test.ts uses: the Electron `session` export only. */
function installElectronSessionStub(): void {
  const resolved = require.resolve('electron');
  if (!require.cache[resolved]) require(resolved);
  const entry = require.cache[resolved];
  if (!entry) throw new Error('electron module could not be resolved for the session stub');
  entry.exports = {
    session: {
      fromPartition: (partition: string) => {
        let sess = sessionsByPartition.get(partition);
        if (!sess) {
          sess = makeFakeSession(partition);
          sessionsByPartition.set(partition, sess);
        }
        return sess;
      },
      defaultSession: makeFakeSession('default'),
    },
  } as unknown as typeof entry.exports;
}

let partitions: typeof PartitionModule;
let HostCtor: typeof HostModule.NativeTabHost;
let SAVED_VERSION: number;

before(() => {
  installElectronSessionStub();
  partitions = require('../../src/main/browser/browser-session-partition') as typeof PartitionModule;
  const hostModule = require('../../src/main/browser/native-tab-host') as typeof HostModule;
  HostCtor = hostModule.NativeTabHost;
  SAVED_VERSION = hostModule.SAVED_TABS_SCHEMA_VERSION;
});

describe('cookie jar in the session registry', () => {
  it('a jar session is a jar, durable, and neither a capsule nor a profile jar', () => {
    for (const mode of ['clean', 'native'] as const) {
      const partition = deriveCookieJarPartition('tiktok-taphoa', mode);
      const sess = partitions.configureBrowserSessionPartition(partition, mode);
      assert.equal(partitions.getBrowserSessionPartition(sess), partition);
      assert.equal(partitions.isCookieJarSession(sess), true, partition);
      assert.equal(partitions.isEphemeralSession(sess), false, `${partition} must persist to disk`);
      assert.equal(partitions.isCapsuleSession(sess), false, partition);
    }
  });

  it('a profile, a capsule and an ephemeral session are not jars', () => {
    const others = ['persist:profile-default', 'persist:profile-profile-2', partitions.deriveCapsulePartition('cap-1', 'clean'), 'ephemeral-abc-xyz'];
    for (const partition of others) {
      const sess = partitions.configureBrowserSessionPartition(partition, 'clean');
      assert.equal(partitions.isCookieJarSession(sess), false, partition);
    }
  });

  it('two jars are two sessions, and the same name returns the same session', () => {
    const a = partitions.configureBrowserSessionPartition(deriveCookieJarPartition('jar-one'), 'clean');
    const b = partitions.configureBrowserSessionPartition(deriveCookieJarPartition('jar-two'), 'clean');
    const aAgain = partitions.configureBrowserSessionPartition(deriveCookieJarPartition('jar-one'), 'clean');
    assert.notEqual(a, b);
    assert.equal(a, aAgain);
  });

  it('a session this process never configured is not a jar', () => {
    assert.equal(partitions.isCookieJarSession(makeFakeSession('persist:jar-unseen') as never), false);
    assert.equal(partitions.isCookieJarSession(undefined as never), false);
  });
});

describe('partition-addressed routes refuse a jar', () => {
  it('isValidCapsulePartition never accepts a jar partition, even while a tab lives in it', () => {
    const host = Object.create(HostCtor.prototype) as { tabs: Map<string, { state: { partition: string } }>; isValidCapsulePartition(p: string): boolean };
    const partition = deriveCookieJarPartition('tiktok-taphoa');
    host.tabs = new Map([['t1', { state: { partition } }]]);
    assert.equal(host.isValidCapsulePartition(partition), false);
    assert.equal(host.isValidCapsulePartition(deriveCookieJarPartition('tiktok-taphoa', 'native')), false);
    assert.equal(host.isValidCapsulePartition(`  ${partition}  `), false);
    // The route still serves the partitions it always served.
    assert.equal(host.isValidCapsulePartition('persist:profile-default'), true);
  });
});

describe('cookie jar and partition cleanup', () => {
  function makeTree(): { root: string; profileDir: string; configDir: string; partitionsDir: string } {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'antifan-jar-clean-'));
    const profileDir = path.join(root, 'profile');
    const configDir = path.join(root, 'config');
    const partitionsDir = path.join(profileDir, 'Partitions');
    fs.mkdirSync(partitionsDir, { recursive: true });
    fs.mkdirSync(configDir, { recursive: true });
    return { root, profileDir, configDir, partitionsDir };
  }

  function makePartition(partitionsDir: string, name: string): string {
    const dir = path.join(partitionsDir, name);
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'Cookies'), Buffer.alloc(1024, 1));
    // Old enough that no quiet-period guard could be what keeps it.
    const old = new Date(Date.now() - 72 * 60 * 60 * 1000);
    fs.utimesSync(path.join(dir, 'Cookies'), old, old);
    fs.utimesSync(dir, old, old);
    return dir;
  }

  it('no jar directory name is a dead-partition name, whatever follows jar-', () => {
    for (const name of ['jar-tiktok-taphoa', 'jar-tiktok-taphoa-native', 'jar-capsule-capsule-4f9c1b2e', 'jar-profile-capsule-9a1d0c33', 'jar-ab']) {
      assert.equal(isDeadPartitionName(name), false, name);
    }
    // Control: the pattern still catches what it was written for.
    assert.equal(isDeadPartitionName('capsule-capsule-4f9c1b2e-77aa-4c6f-9d10-8b2c5e0a1f33'), true);
  });

  it('keeps a jar on disk while dead partitions beside it are reclaimed, with and without a tab in it', () => {
    const tree = makeTree();
    try {
      const jar = makePartition(tree.partitionsDir, 'jar-tiktok-taphoa');
      const jarNative = makePartition(tree.partitionsDir, 'jar-tiktok-taphoa-native');
      const lookalike = makePartition(tree.partitionsDir, 'jar-capsule-capsule-4f9c1b2e-77aa-4c6f-9d10-8b2c5e0a1f33');
      const dead = makePartition(tree.partitionsDir, 'capsule-capsule-4f9c1b2e-77aa-4c6f-9d10-8b2c5e0a1f33');

      // No tab lives in any jar: nothing but the dead partition may go.
      const first = pruneDeadStores({ profileDir: tree.profileDir, configDir: tree.configDir, livePartitions: [] });
      assert.equal(fs.existsSync(dead), false, 'the dead partition is reclaimed');
      for (const dir of [jar, jarNative, lookalike]) {
        assert.equal(fs.existsSync(path.join(dir, 'Cookies')), true, `${dir} was deleted`);
      }
      assert.deepEqual(first.deletedPartitions, ['capsule-capsule-4f9c1b2e-77aa-4c6f-9d10-8b2c5e0a1f33']);
      assert.equal(first.skippedPartitions.some((name) => name.startsWith('jar-')), false);

      // A tab is open in the jar: still nothing from the jar set is touched.
      const second = pruneDeadStores({ profileDir: tree.profileDir, configDir: tree.configDir, livePartitions: ['persist:jar-tiktok-taphoa'] });
      assert.deepEqual(second.deletedPartitions, []);
      assert.equal(fs.existsSync(path.join(jar, 'Cookies')), true);
    } finally {
      fs.rmSync(tree.root, { recursive: true, force: true });
    }
  });

  it('the legacy capsule migration only reads capsule-* directories and never writes toward a jar', async () => {
    const tree = makeTree();
    try {
      makePartition(tree.partitionsDir, 'jar-tiktok-taphoa');
      makePartition(tree.partitionsDir, 'capsule-capsule-1f');
      // The enumeration the host hands the migration (native-tab-host migrateLegacyCapsuleToProfile).
      const read: string[] = [];
      const written: string[] = [];
      const listLegacyPartitionKeys = (): string[] =>
        fs.readdirSync(tree.partitionsDir).filter((n) => n.startsWith('capsule-'));
      const result = await runCapsuleToProfileMigration({
        listLegacyPartitionKeys,
        readCookies: async (partition) => {
          read.push(partition);
          return [{ domain: '.example.com', path: '/', secure: true, httpOnly: true, name: 'sid', value: 'v' }];
        },
        writeCookie: async (target) => { written.push(target); },
        flushStore: async () => {},
      });
      assert.deepEqual(read, ['persist:capsule-capsule-1f']);
      assert.deepEqual(written, ['persist:profile-1f']);
      assert.equal([...read, ...written].some((p) => p.includes('jar-')), false);
      assert.equal(result.markerReady, true);
    } finally {
      fs.rmSync(tree.root, { recursive: true, force: true });
    }
  });
});

describe('restore keeps the jar', () => {
  const PROJECT_ID = 'project-00000000-0000-4000-8000-0000000007e2';
  const owner = { kind: 'project', projectId: PROJECT_ID } as const;

  function tabRow(id: string, extra: Partial<AntiFanTab>): Record<string, unknown> {
    const state = {
      id, url: `https://${id}.example/`, title: id, isLoading: false, canGoBack: false, canGoForward: false,
      zoomFactor: 1, devicePresetId: 'responsive', crashed: false, ...extra,
    } as AntiFanTab;
    return sanitizeTabForPersistence(state) as unknown as Record<string, unknown>;
  }

  /** Runs the real restoreTabs() over a saved document and returns the options each mint received. */
  function restore(rows: Array<Record<string, unknown>>): Array<{ url: string; options: Record<string, unknown> | undefined }> {
    const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'antifan-restore-jar-'));
    const tabsPath = path.join(tempRoot, 'saved-tabs.json');
    fs.writeFileSync(
      tabsPath,
      JSON.stringify({
        version: SAVED_VERSION,
        owners: { [ownerKey(owner as never)]: { tabs: rows, activeTabId: rows[0]?.id, updatedAt: Date.now() } },
        updatedAt: Date.now(),
      }),
      'utf8',
    );
    const host: Record<string, unknown> = Object.create(HostCtor.prototype);
    host.shell = { owner, isSidebarOpen: false, sidebarWidth: 380 };
    host.mutedSites = new Set<string>();
    host.bookmarks = [];
    host.tabs = new Map();
    host.tabOrder = [];
    const minted: Array<{ url: string; options: Record<string, unknown> | undefined }> = [];
    host.createTab = (url: string, _activate?: boolean, options?: Record<string, unknown>) => {
      minted.push({ url, options });
      const id = `minted-${minted.length}`;
      (host.tabs as Map<string, unknown>).set(id, { state: { id } });
      (host.tabOrder as string[]).push(id);
      return id;
    };
    host.getTabsStoragePath = () => tabsPath;
    host.applyTerminalTabPrefs = () => {};
    host.restoreMutedSites = () => {};
    host.setDevicePreset = () => {};
    host.toggleSplitReview = () => {};
    host.updateLayout = () => {};
    host.getToolbarHeight = () => 0;
    host.switchTab = () => {};
    try {
      (host.restoreTabs as () => void)();
    } finally {
      fs.rmSync(tempRoot, { recursive: true, force: true });
    }
    return minted;
  }

  it('a tab saved in a jar is minted in that jar, in the user-agent mode it was saved with', () => {
    const minted = restore([
      tabRow('jarred', { cookieJar: 'tiktok-taphoa', partition: 'persist:jar-tiktok-taphoa' }),
      tabRow('jarred-native', { cookieJar: 'tiktok-taphoa', userAgentMode: 'native', partition: 'persist:jar-tiktok-taphoa-native' }),
    ]);
    assert.equal(minted.length, 2);
    assert.equal(minted[0]!.options?.cookieJar, 'tiktok-taphoa');
    assert.equal(minted[1]!.options?.cookieJar, 'tiktok-taphoa');
    assert.equal(minted[1]!.options?.userAgentMode, 'native');
    // The raw partition option stays internal: restore names the jar, never a partition.
    assert.equal('partition' in (minted[0]!.options ?? {}), false);
  });

  it('a tab saved in the shared profile jar is not given a jar, and a mixed strip keeps each tab where it was', () => {
    const minted = restore([
      tabRow('plain', { partition: 'persist:profile-default' }),
      tabRow('jarred', { cookieJar: 'tiktok-taphoa', partition: 'persist:jar-tiktok-taphoa' }),
      tabRow('other-jar', { cookieJar: 'second-acct', partition: 'persist:jar-second-acct' }),
    ]);
    assert.equal(minted.length, 3);
    assert.equal('cookieJar' in (minted[0]!.options ?? {}), false);
    assert.equal(minted[1]!.options?.cookieJar, 'tiktok-taphoa');
    assert.equal(minted[2]!.options?.cookieJar, 'second-acct');
  });

  it('a saved row with a made-up jar name restores into the shared jar rather than a jar nobody opened', () => {
    const row = tabRow('forged', { partition: 'persist:profile-default' });
    row.cookieJar = '../profile-default';
    const minted = restore([row]);
    assert.equal(minted.length, 1);
    assert.equal('cookieJar' in (minted[0]!.options ?? {}), false);
  });
});
