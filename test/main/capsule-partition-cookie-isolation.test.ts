/**
 * Capsule partition isolation: RFC 6265bis ingestion semantics plus the production
 * partition lifecycle that keeps a disposable run from reusing persistent capsule state.
 *
 * `POST /api/cookies/import` is retained and authenticated (covered by
 * bridge-cookie-import-endpoint-removed.test.ts); the endpoint removed by the
 * native-messaging cutover was `GET /api/extension/handshake`.
 *
 * The partition tests drive `configureBrowserSessionPartition` and its siblings against a
 * stubbed Electron `session` boundary, so they assert what production does to a session —
 * which partition it configures, what policy it applies, and which policies it forgets.
 */
import { describe, it, before, beforeEach, after } from 'node:test';
import * as assert from 'node:assert';
import { extensionCookieImportSetDetails } from '../../src/main/browser/chrome-profile-sync';
import type * as PartitionModule from '../../src/main/browser/browser-session-partition';

type PartitionApi = typeof PartitionModule;

const ELECTRON_UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) AntiFan/1.0.0 Electron/43.4.0 Chrome/140.0.0.0 Safari/537.36';
const CLEAN_UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Safari/537.36';

interface FakeSessionRecord {
  partition: string;
  userAgent: string;
  setUserAgentCalls: string[];
  hintInterceptorInstalls: number;
}

interface FakeSession {
  readonly partition: string;
  readonly record: FakeSessionRecord;
  getUserAgent(): string;
  setUserAgent(ua: string): void;
  webRequest: { onBeforeSendHeaders(filter: unknown, handler: unknown): void };
}

function makeFakeSession(partition: string): FakeSession {
  const record: FakeSessionRecord = {
    partition,
    userAgent: ELECTRON_UA,
    setUserAgentCalls: [],
    hintInterceptorInstalls: 0,
  };
  return {
    partition,
    record,
    getUserAgent: () => record.userAgent,
    setUserAgent: (ua: string) => {
      record.setUserAgentCalls.push(ua);
      record.userAgent = ua;
    },
    webRequest: {
      onBeforeSendHeaders: () => {
        record.hintInterceptorInstalls += 1;
      },
    },
  };
}

const sessionsByPartition = new Map<string, FakeSession>();
const fromPartitionCalls: string[] = [];
const defaultSession = makeFakeSession('default');

function installElectronSessionStub(): void {
  const resolved = require.resolve('electron');
  if (!require.cache[resolved]) require(resolved);
  const entry = require.cache[resolved];
  if (!entry) throw new Error('electron module could not be resolved for the session stub');
  entry.exports = {
    session: {
      fromPartition: (partition: string) => {
        fromPartitionCalls.push(partition);
        let sess = sessionsByPartition.get(partition);
        if (!sess) {
          sess = makeFakeSession(partition);
          sessionsByPartition.set(partition, sess);
        }
        return sess;
      },
      defaultSession,
    },
  } as unknown as typeof entry.exports;
}

let partitions: PartitionApi;

before(() => {
  installElectronSessionStub();
  // Required after the stub is installed: the production module captures the electron export
  // when it loads, so a stub installed afterwards would never be observed.
  partitions = require('../../src/main/browser/browser-session-partition') as PartitionApi;
});

beforeEach(() => {
  partitions.clearBrowserSessionPartitionPolicies();
  sessionsByPartition.clear();
  fromPartitionCalls.length = 0;
});

const partitionRecord = (partition: string): FakeSessionRecord => {
  const sess = sessionsByPartition.get(partition);
  assert.ok(sess, `no session was created for partition ${partition}`);
  return sess.record;
};

describe('Capsule partition isolation & RFC 6265bis ingestion suite (unit)', () => {
  it('enforces RFC 6265bis host-only, __Host- prefix, and expiration rules', () => {
    // 1. __Host- cookie forces no domain attribute
    const hostPrefixed = extensionCookieImportSetDetails({
      name: '__Host-user',
      value: 'u123',
      domain: '.haravan.com',
      path: '/',
      secure: true,
      httpOnly: true,
      sameSite: 'strict',
    });
    assert.ok(hostPrefixed);
    assert.strictEqual(hostPrefixed.domain, undefined);
    assert.strictEqual(hostPrefixed.secure, true);

    // 2. Expired cookie returns null (skipped)
    const expired = extensionCookieImportSetDetails({
      name: 'stale',
      value: 'old',
      domain: '.shopify.com',
      expirationDate: Math.floor(Date.now() / 1000) - 100,
    });
    assert.strictEqual(expired, null);
  });

  it('derives one persistent partition per capsule and a unique ephemeral partition per disposable run', () => {
    const persistent = partitions.deriveCapsulePartition('store-prod', 'clean');
    const persistentNative = partitions.deriveCapsulePartition('store-prod', 'native');
    const ephemeralA = partitions.deriveCapsulePartition('store-prod', 'clean', true);
    const ephemeralB = partitions.deriveCapsulePartition('store-prod', 'clean', true);

    assert.strictEqual(persistent, 'persist:capsule-store-prod');
    assert.strictEqual(persistentNative, 'persist:capsule-store-prod-native');
    assert.strictEqual(ephemeralA.startsWith('ephemeral-store-prod-'), true);
    assert.strictEqual(ephemeralA.includes('persist:'), false);
    assert.notStrictEqual(ephemeralA, ephemeralB, 'Each ephemeral partition must have a unique non-persistent nonce');
  });

  it('configures the session of the requested partition and applies the clean user agent there', () => {
    const partition = partitions.deriveCapsulePartition('store-prod', 'clean');
    const sess = partitions.configureBrowserSessionPartition(partition, 'clean');

    assert.deepStrictEqual(fromPartitionCalls, [partition], 'production must configure the derived capsule partition');
    assert.strictEqual(sess, sessionsByPartition.get(partition), 'the returned session is the partition session');
    const record = partitionRecord(partition);
    assert.deepStrictEqual(record.setUserAgentCalls, [CLEAN_UA], 'clean mode must strip the Electron and app tokens');
    assert.strictEqual(record.hintInterceptorInstalls, 1, 'clean mode installs one client-hints interceptor');
    assert.strictEqual(partitions.getBrowserSessionUserAgentMode(sess), 'clean');
  });

  it('keeps authentic headers in native mode and never installs a client-hints interceptor', () => {
    const partition = partitions.deriveCapsulePartition('store-prod', 'native');
    const sess = partitions.configureBrowserSessionPartition(partition, 'native');

    const record = partitionRecord(partition);
    assert.deepStrictEqual(record.setUserAgentCalls, [], 'native mode must not rewrite the user agent');
    assert.strictEqual(record.hintInterceptorInstalls, 0, 'native mode must not tamper with request headers');
    assert.strictEqual(record.userAgent, ELECTRON_UA);
    assert.strictEqual(partitions.getBrowserSessionUserAgentMode(sess), 'native');
  });

  it('re-applies policy only after the partition is forgotten, so a disposable run reconfigures while a capsule keeps its session', () => {
    const persistent = partitions.deriveCapsulePartition('store-prod', 'clean');
    partitions.configureBrowserSessionPartition(persistent, 'clean');
    partitions.configureBrowserSessionPartition(persistent, 'clean');
    assert.strictEqual(
      partitionRecord(persistent).hintInterceptorInstalls,
      1,
      'a partition that is already configured is not configured again',
    );
    assert.strictEqual(
      partitionRecord(persistent).setUserAgentCalls.length,
      1,
      're-configuring must not rewrite a user agent that is already clean',
    );

    const ephemeral = partitions.deriveCapsulePartition('store-prod', 'clean', true);
    partitions.configureBrowserSessionPartition(ephemeral, 'clean');
    const ephemeralSession = sessionsByPartition.get(ephemeral);
    assert.ok(ephemeralSession && ephemeralSession !== sessionsByPartition.get(persistent), 'a disposable run gets its own session');
    assert.strictEqual(partitionRecord(ephemeral).hintInterceptorInstalls, 1);

    // The disposable run ends: only its own policy is dropped.
    partitions.unconfigureBrowserSessionPartition(ephemeral);
    partitions.configureBrowserSessionPartition(ephemeral, 'clean');
    assert.strictEqual(
      partitionRecord(ephemeral).hintInterceptorInstalls,
      2,
      'a forgotten ephemeral partition is configured again',
    );
    assert.strictEqual(
      partitionRecord(persistent).hintInterceptorInstalls,
      1,
      'forgetting an ephemeral run must not touch the persistent capsule session',
    );

    // The persistent capsule keeps its policy until it is explicitly reset.
    partitions.clearBrowserSessionPartitionPolicies(persistent);
    partitions.configureBrowserSessionPartition(persistent, 'clean');
    assert.strictEqual(partitionRecord(persistent).hintInterceptorInstalls, 2);
  });

  it('falls back to the default session when no partition is requested', () => {
    const sess = partitions.configureBrowserSessionPartition('', 'clean');
    assert.strictEqual(sess, defaultSession, 'an empty partition configures the default session');
    assert.strictEqual(defaultSession.record.setUserAgentCalls.length, 1);
  });
});

after(() => {
  partitions.clearBrowserSessionPartitionPolicies();
});
