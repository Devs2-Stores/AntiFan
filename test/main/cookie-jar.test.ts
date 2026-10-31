/**
 * Named cookie jars (`cookieJar` on `anti.browser.tabs.create`).
 *
 * Covers the Electron-free half of the contract: the name rule, the partition a name
 * derives, the argument check at the capability boundary (every spelling of the tab-open
 * capability), the advertised schema on every surface, and the persisted tab row that
 * lets a restored tab reopen in its jar. The session-registry, credential-guard,
 * cleanup and restore halves live in cookie-jar-session.test.ts.
 */
import { describe, it } from 'node:test';
import * as assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';
import {
  COOKIE_JAR_PARTITION_PREFIX,
  cookieJarNameOfPartition,
  deriveCookieJarPartition,
  isCookieJarPartition,
  isValidCookieJarName,
  parseCookieJarParam,
} from '../../src/main/browser/cookie-jar';
import { migratePersistedTab, sanitizeTabForPersistence } from '../../src/main/browser/split-review-coordinator';
import { CapabilityCatalogue } from '../../src/main/tools/capability-catalogue';
import { registerBrowserCapabilities } from '../../src/main/tools/browser-capabilities';
import { LIST_TAB_FIELDS, type BrowserControlPort } from '../../src/main/tools/browser-control-port';
import { buildMcpToolList } from '../../src/main/mcp/mcp-tool-list';
import { CapabilityError, type CapabilityRequestContext, type RuntimeLease } from '../../src/shared/control-plane-contracts';
import type { AntiFanTab } from '../../src/shared/contracts';
import type { CapabilityTransportAdapter } from '../../src/main/tools/capability-transport';

const OPEN_TAB_NAMES = ['browser.open-tab', 'antifan_open_tab', 'anti.browser.tabs.create'] as const;

describe('cookie jar names', () => {
  it('accepts lowercase letters, digits and hyphens of 2-40 characters', () => {
    for (const name of ['tiktok-taphoa', 'ab', 'a1', '0x', 'a-b-c', 'x'.repeat(40)]) {
      assert.equal(isValidCookieJarName(name), true, name);
    }
  });

  it('refuses everything else', () => {
    const bad: unknown[] = [
      '', 'a', 'x'.repeat(41), 'Upper', 'has space', 'under_score', 'dot.name', 'slash/name', 'back\\slash',
      '-leading', 'ab-native', 'ab\n', '../x', 'persist:profile-x', 'tiktok taphoa', 'jar-é', 12, null, undefined, {}, ['ab'],
    ];
    for (const name of bad) {
      assert.equal(isValidCookieJarName(name), false, String(JSON.stringify(name)));
    }
  });
});

describe('cookie jar partition derivation', () => {
  it('derives persist:jar-<name>, with the -native suffix in native UA mode', () => {
    assert.equal(deriveCookieJarPartition('tiktok-taphoa'), 'persist:jar-tiktok-taphoa');
    assert.equal(deriveCookieJarPartition('tiktok-taphoa', 'clean'), 'persist:jar-tiktok-taphoa');
    assert.equal(deriveCookieJarPartition('tiktok-taphoa', 'native'), 'persist:jar-tiktok-taphoa-native');
  });

  it('refuses to derive a partition from an invalid name', () => {
    for (const name of ['', 'X', 'ab-native', '../profile-x']) {
      assert.throws(() => deriveCookieJarPartition(name), (e: unknown) => e instanceof CapabilityError && e.code === 'INVALID_ARGUMENT', name);
    }
  });

  it('never resolves to a profile, capsule or ephemeral partition, whatever the name', () => {
    // Names chosen to look like the namespaces a jar must not collide with.
    const lookalikes = ['profile-default', 'profile-1', 'capsule-abc', 'capsule-capsule-1f', 'ephemeral-x1', 'persist', 'default', 'native', 'tiktok-taphoa'];
    for (const name of lookalikes) {
      if (!isValidCookieJarName(name)) continue;
      for (const mode of ['clean', 'native'] as const) {
        const partition = deriveCookieJarPartition(name, mode);
        assert.ok(partition.startsWith(COOKIE_JAR_PARTITION_PREFIX), partition);
        assert.ok(partition.startsWith('persist:jar-'), partition);
        assert.ok(!partition.startsWith('persist:profile-'), partition);
        assert.ok(!partition.startsWith('persist:capsule-'), partition);
        assert.ok(!/^(persist:)?ephemeral-/.test(partition), partition);
        assert.ok(isCookieJarPartition(partition));
      }
    }
  });

  it('two names never share a partition, and the native twin of a name is not another jar', () => {
    const seen = new Map<string, string>();
    for (const name of ['aa', 'ab', 'tiktok-a', 'tiktok-b', 'a-b']) {
      for (const mode of ['clean', 'native'] as const) {
        const partition = deriveCookieJarPartition(name, mode);
        assert.equal(seen.has(partition), false, `${partition} derived twice`);
        seen.set(partition, `${name}/${mode}`);
      }
    }
  });

  it('reads the name back from a partition of the same mode, and from nothing else', () => {
    assert.equal(cookieJarNameOfPartition('persist:jar-tiktok-taphoa'), 'tiktok-taphoa');
    assert.equal(cookieJarNameOfPartition('persist:jar-tiktok-taphoa-native', 'native'), 'tiktok-taphoa');
    // A clean partition whose name would end in -native is not a jar; nor is a native partition without the suffix.
    assert.equal(cookieJarNameOfPartition('persist:jar-tiktok-taphoa-native', 'clean'), undefined);
    assert.equal(cookieJarNameOfPartition('persist:jar-tiktok-taphoa', 'native'), undefined);
    for (const partition of ['persist:profile-default', 'persist:capsule-x', 'ephemeral-x', 'persist:jar-', 'persist:jar-X', '', undefined, null, 7]) {
      assert.equal(cookieJarNameOfPartition(partition), undefined, String(partition));
      assert.equal(cookieJarNameOfPartition(partition, 'native'), undefined, String(partition));
    }
    for (const partition of ['persist:profile-default', 'persist:capsule-x', 'ephemeral-x', 'persist:profile-jar-x', undefined, null]) {
      assert.equal(isCookieJarPartition(partition), false, String(partition));
    }
  });
});

describe('cookieJar argument check', () => {
  const invalid = (e: unknown) => e instanceof CapabilityError && e.code === 'INVALID_ARGUMENT';

  it('passes an absent argument through as undefined', () => {
    assert.equal(parseCookieJarParam(undefined), undefined);
    assert.equal(parseCookieJarParam(null), undefined);
    assert.equal(parseCookieJarParam(undefined, true), undefined);
  });

  it('returns a valid name unchanged', () => {
    assert.equal(parseCookieJarParam('tiktok-taphoa'), 'tiktok-taphoa');
    assert.equal(parseCookieJarParam('tiktok-taphoa', false), 'tiktok-taphoa');
  });

  it('refuses a bad name, a wrong type and an empty string with INVALID_ARGUMENT', () => {
    for (const value of ['', 'A', 'x', 'bad name', 'x'.repeat(41), 'ab-native', 5, true, {}, []]) {
      assert.throws(() => parseCookieJarParam(value), invalid, String(JSON.stringify(value)));
    }
  });

  it('refuses a jar together with ephemeral: true, and allows it with ephemeral: false', () => {
    assert.throws(() => parseCookieJarParam('tiktok-taphoa', true), invalid);
    assert.equal(parseCookieJarParam('tiktok-taphoa', false), 'tiktok-taphoa');
  });
});

const projectId = 'proj-jar';
const workspaceId = 'ws-jar';
const lease: RuntimeLease = {
  token: 'lease-tok', expiresAt: Date.now() + 60_000, runtimeId: 'run-1', projectId, workspaceId,
  protocolVersion: 1, hostEpoch: 1, ownerPid: process.pid, issuedAt: Date.now(),
};
const context: CapabilityRequestContext = {
  lease, leaseToken: 'lease-tok', projectId, workspaceId, runId: 'run-1', attemptId: 'att-1', grant: 'write',
};

function scenario(): { catalogue: CapabilityCatalogue; calls: string[]; opened: Array<Record<string, unknown>> } {
  const calls: string[] = [];
  const opened: Array<Record<string, unknown>> = [];
  const port = {
    ensureHostForNewTab: async () => { calls.push('ensure'); },
    openTab: (options: Record<string, unknown>) => { calls.push('open'); opened.push(options); return { tabId: 'tab-new' }; },
  } as unknown as BrowserControlPort;
  const catalogue = new CapabilityCatalogue({
    runtime: { mode: 'standalone', lifecycle: 'active' }, projectId, workspaceId, runtimeId: 'run-1', hostEpoch: 1,
  });
  registerBrowserCapabilities(catalogue, port);
  return { catalogue, calls, opened };
}

describe('cookieJar at the capability boundary', () => {
  for (const name of OPEN_TAB_NAMES) {
    it(`${name} hands a valid jar to the control port`, async () => {
      const { catalogue, opened } = scenario();
      const capability = catalogue.get(name);
      assert.ok(capability, `${name} must be registered`);
      await capability.execute({ url: 'about:blank', cookieJar: 'tiktok-taphoa' }, context);
      assert.equal(opened.length, 1);
      assert.equal(opened[0]!.cookieJar, 'tiktok-taphoa');
      assert.equal(opened[0]!.url, 'about:blank');
    });

    it(`${name} omits the jar when none was asked for`, async () => {
      const { catalogue, opened } = scenario();
      await catalogue.get(name)!.execute({ url: 'about:blank' }, context);
      assert.equal('cookieJar' in opened[0]!, false);
    });

    it(`${name} refuses an invalid jar name before any window or tab is allocated`, async () => {
      for (const cookieJar of ['Bad Name', 'x', 'ab-native', '../profile-x', 7]) {
        const { catalogue, calls } = scenario();
        await assert.rejects(
          () => Promise.resolve(catalogue.get(name)!.execute({ cookieJar }, context)),
          (e: unknown) => e instanceof CapabilityError && e.code === 'INVALID_ARGUMENT',
          String(JSON.stringify(cookieJar)),
        );
        assert.deepEqual(calls, [], `${name} allocated something for ${JSON.stringify(cookieJar)}`);
      }
    });

    it(`${name} refuses a jar combined with ephemeral: true before any window or tab is allocated`, async () => {
      const { catalogue, calls } = scenario();
      await assert.rejects(
        () => Promise.resolve(catalogue.get(name)!.execute({ cookieJar: 'tiktok-taphoa', ephemeral: true }, context)),
        (e: unknown) => e instanceof CapabilityError && e.code === 'INVALID_ARGUMENT',
      );
      assert.deepEqual(calls, []);
    });
  }

  it('the control port refuses the combination too, for in-process callers that skip the capability', () => {
    const { BrowserControlPort: Port } = require('../../src/main/tools/browser-control-port') as typeof import('../../src/main/tools/browser-control-port');
    const host = { createTab: () => { throw new Error('createTab must not be reached'); } };
    const port = new Port(host as never);
    assert.throws(
      () => port.openTab({ cookieJar: 'tiktok-taphoa', ephemeral: true }),
      (e: unknown) => e instanceof CapabilityError && e.code === 'INVALID_ARGUMENT',
    );
  });
});

describe('cookieJar in the advertised schema', () => {
  it('every tab-open capability declares it as an optional string with the name pattern', () => {
    const { catalogue } = scenario();
    for (const name of OPEN_TAB_NAMES) {
      const schema = catalogue.get(name)!.inputSchema as { properties?: Record<string, { type?: string; pattern?: string }>; required?: string[] };
      const property = schema.properties?.cookieJar;
      assert.ok(property, `${name} lacks cookieJar`);
      assert.equal(property.type, 'string');
      assert.equal(property.pattern, '^[a-z0-9][a-z0-9-]{1,39}$');
      assert.ok(!(schema.required ?? []).includes('cookieJar'), `${name} must keep cookieJar optional`);
      // The advertised pattern is the runtime rule.
      const re = new RegExp(property.pattern);
      assert.equal(re.test('tiktok-taphoa'), true);
      assert.equal(re.test('Bad'), false);
    }
  });

  it('the MCP tool list a client sees carries it on anti.browser.tabs.create', () => {
    const { catalogue } = scenario();
    const transport = { list: () => catalogue.listAll() } as unknown as CapabilityTransportAdapter;
    const tools = buildMcpToolList([], transport);
    for (const name of OPEN_TAB_NAMES) {
      const tool = tools.find((candidate) => candidate.name === name);
      assert.ok(tool, `${name} is not advertised`);
      const properties = (tool.inputSchema as { properties?: Record<string, unknown> }).properties ?? {};
      assert.ok('cookieJar' in properties, `${name} advertises no cookieJar`);
    }
  });

  it('the stdio proxy and the in-process MCP server declare it on the tab-open tool', () => {
    const repo = path.resolve(__dirname, '..', '..', '..');
    const proxy = fs.readFileSync(path.join(repo, 'scripts', 'antifan-omp-mcp.cjs'), 'utf8');
    const proxyRow = proxy.split('\n').find((line) => line.includes("['anti.browser.tabs.create'"));
    assert.ok(proxyRow, 'proxy has no anti.browser.tabs.create definition');
    assert.match(proxyRow, /cookieJar: \{ type: 'string', pattern: '\^\[a-z0-9\]\[a-z0-9-\]\{1,39\}\$'/);
    const server = fs.readFileSync(path.join(repo, 'src', 'main', 'mcp', 'mcp-server.ts'), 'utf8');
    assert.match(server, /name: 'antifan_open_tab'[\s\S]{0,2000}cookieJar: \{ type: 'string', pattern/);
  });
});

describe('cookieJar on tab rows and saved rows', () => {
  it('tabs.list may select the cookieJar column', () => {
    assert.ok(LIST_TAB_FIELDS.includes('cookieJar'));
    assert.ok(LIST_TAB_FIELDS.includes('partition'), 'the existing partition column stays');
  });

  function tab(extra: Partial<AntiFanTab>): AntiFanTab {
    return {
      id: 'tab-1', url: 'https://www.tiktok.com/', title: 'TikTok', isLoading: false, canGoBack: false, canGoForward: false,
      zoomFactor: 1, devicePresetId: 'responsive', crashed: false, ...extra,
    } as AntiFanTab;
  }

  it('a saved row carries the jar name and nothing of the partition', () => {
    const row = sanitizeTabForPersistence(tab({ cookieJar: 'tiktok-taphoa', partition: 'persist:jar-tiktok-taphoa' } as Partial<AntiFanTab>));
    assert.equal(row.cookieJar, 'tiktok-taphoa');
    assert.equal('partition' in row, false);
  });

  it('a tab without a jar saves no cookieJar key', () => {
    assert.equal('cookieJar' in sanitizeTabForPersistence(tab({})), false);
  });

  it('a malformed name in a saved row is dropped, so a restored tab never lands in a made-up jar', () => {
    for (const bad of ['Bad Name', 'ab-native', '', 5, null, {}]) {
      assert.equal(sanitizeTabForPersistence(tab({ cookieJar: bad as never })).cookieJar, undefined, String(JSON.stringify(bad)));
      assert.equal(migratePersistedTab({ id: 't', url: 'https://x.test/', cookieJar: bad as never }).cookieJar, undefined, String(JSON.stringify(bad)));
    }
  });

  it('a saved row survives JSON and migrates back with its jar and user-agent mode', () => {
    const saved = JSON.parse(JSON.stringify(sanitizeTabForPersistence(tab({ cookieJar: 'tiktok-taphoa', userAgentMode: 'native' }))));
    const migrated = migratePersistedTab(saved);
    assert.equal(migrated.cookieJar, 'tiktok-taphoa');
    assert.equal(migrated.userAgentMode, 'native');
  });
});
