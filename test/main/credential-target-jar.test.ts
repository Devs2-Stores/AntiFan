/**
 * Credential target-jar contract for the Session Vault.
 *
 * Vault export/import, and the Chrome-profile sync that writes through it, must
 * land in a durable shared-profile jar (`persist:profile-*`). Two other jars
 * accept the write and then keep it from the next launch's profile sync: an
 * in-memory (`ephemeral-*`) jar, which dies with the process, and a
 * workspace-scoped capsule jar (`persist:capsule-*`), which persists but is
 * never read by the profile session. Both are refused, and the refusal names the
 * jar it refused so a caller can report where the cookies did not land.
 *
 * The partitions are registered through the production entry point so the test
 * exercises the same partition-to-session registry the app reads.
 */
import { describe, it, before } from 'node:test';
import * as assert from 'node:assert';
import type * as PartitionModule from '../../src/main/browser/browser-session-partition';
import type * as VaultModule from '../../src/main/browser/local-session-vault';

type PartitionApi = typeof PartitionModule;

interface FakeCookieStore {
  rows: Record<string, unknown>[];
  setCalls: number;
  flushCalls: number;
  set(details: Record<string, unknown>): Promise<void>;
  get(query: Record<string, unknown>): Promise<Record<string, unknown>[]>;
  remove(details: Record<string, unknown>): Promise<void>;
  flushStore(): Promise<void>;
  on(event: string, listener: () => void): void;
}

interface FakeSession {
  cookies: FakeCookieStore;
  getUserAgent(): string;
  setUserAgent(ua: string): void;
  webRequest: { onBeforeSendHeaders(filter: unknown, handler: unknown): void };
}

const sessions = new Map<string, FakeSession>();

function makeFakeSession(): FakeSession {
  const cookies: FakeCookieStore = {
    rows: [],
    setCalls: 0,
    flushCalls: 0,
    set: async (details) => {
      cookies.setCalls += 1;
      cookies.rows.push({ ...details });
    },
    get: async () => cookies.rows.slice(),
    remove: async () => {},
    flushStore: async () => {
      cookies.flushCalls += 1;
    },
    on: () => {},
  };
  return {
    cookies,
    getUserAgent: () => 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AntiFan/1.0.0 Electron/43.4.0 Chrome/140.0.0.0',
    setUserAgent: () => {},
    webRequest: { onBeforeSendHeaders: () => {} },
  };
}

/** The production module reads the Electron export when it loads: stub first. */
function installElectronSessionStub(): void {
  const resolved = require.resolve('electron');
  if (!require.cache[resolved]) require(resolved);
  const entry = require.cache[resolved];
  if (!entry) throw new Error('electron module could not be resolved for the session stub');
  entry.exports = {
    session: {
      fromPartition: (partition: string) => {
        let sess = sessions.get(partition);
        if (!sess) {
          sess = makeFakeSession();
          sessions.set(partition, sess);
        }
        return sess;
      },
      defaultSession: makeFakeSession(),
    },
  } as unknown as typeof entry.exports;
}

let partitions: PartitionApi;
let vault: typeof VaultModule.LocalSessionVault;

before(() => {
  installElectronSessionStub();
  partitions = require('../../src/main/browser/browser-session-partition') as PartitionApi;
  vault = (require('../../src/main/browser/local-session-vault') as typeof VaultModule).LocalSessionVault;
});

const SESSION_COOKIE = [
  { name: 'haravan_session', value: 'sess_abc123', domain: '.myharavan.com', path: '/', secure: true, httpOnly: true },
];

describe('Session Vault credential target jars', () => {
  it('refuses a workspace-scoped capsule jar and writes nothing into it', async () => {
    const capsuleSession = partitions.configureBrowserSessionPartition('persist:capsule-workspace-7');
    const store = (capsuleSession as unknown as FakeSession).cookies;

    const res = await vault.getInstance().importVaultFromJson(capsuleSession as never, SESSION_COOKIE);

    assert.strictEqual(res.success, false);
    assert.ok(res.error && res.error.startsWith('CAPSULE_TARGET_REJECTED'), `error was '${res.error}'`);
    assert.strictEqual(res.targetJar, 'persist:capsule-workspace-7', 'the refusal must name the jar it refused');
    assert.strictEqual(store.setCalls, 0, 'a refused import must not touch the workspace jar');
  });

  it('writes to a durable shared-profile jar', async () => {
    const profileSession = partitions.configureBrowserSessionPartition('persist:profile-2');
    const store = (profileSession as unknown as FakeSession).cookies;

    const res = await vault.getInstance().importVaultFromJson(profileSession as never, SESSION_COOKIE);

    assert.strictEqual(res.success, true);
    assert.strictEqual(res.importedCount, 1);
    assert.strictEqual(res.targetJar, 'persist:profile-2');
    assert.strictEqual(store.setCalls, 1);
    assert.strictEqual(store.rows[0]?.name, 'haravan_session');
  });

  it('keeps the capsule refusal in the export direction too', async () => {
    const capsuleSession = partitions.configureBrowserSessionPartition('persist:capsule-workspace-7');

    const res = await vault.getInstance().exportVaultToFile(capsuleSession as never);

    assert.strictEqual(res.success, false);
    assert.ok(res.error && res.error.startsWith('CAPSULE_TARGET_REJECTED'), `error was '${res.error}'`);
    assert.strictEqual(res.targetJar, 'persist:capsule-workspace-7');
  });
});
