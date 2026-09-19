/**
 * Pre/post-fix reproduction probe for the companion-extension cookie channel.
 *
 * Symptom under test: cookies extracted by the Chrome companion extension for
 * Google/YouTube are silently dropped by the Electron bridge receiver, so the
 * AntiFan session never becomes signed in ("khong dong bo duoc tu Chrome").
 *
 * Method: mint an extension grant with the DEFAULT allowlist (exactly how
 * src/main/index.ts mints it for the companion), POST a mixed cookie batch
 * through the real authenticated /api/cookies/import route, and report what
 * actually reached the Electron cookie store.
 *
 * Run: node scratch/probe-extension-grant-google-allowlist.cjs
 */
'use strict';

const path = require('path');

const compiledRoot = path.resolve(__dirname, '..', '.compiled');
const bridge = require(path.join(compiledRoot, 'src', 'main', 'bridge', 'bridge-server.js'));
const { BridgeServer, DEFAULT_EXTENSION_ALLOWED_DOMAINS } = bridge;

const TARGET_PARTITION = 'persist:profile-default';

class MockCookieStore {
  constructor() {
    this.setCalls = [];
  }
  async set(cookie) {
    this.setCalls.push(cookie);
  }
  async get() {
    return [];
  }
  async flushStore() {}
}

const { EventEmitter } = require('events');

class MockTabHost extends EventEmitter {
  constructor() {
    super();
    this.cookieStore = new MockCookieStore();
    this.session = { cookies: this.cookieStore };
  }
  getActiveCapsule() {
    return { id: 'capsule-probe' };
  }
  getActiveTab() {
    return { id: 'tab-probe' };
  }
  getActiveTabId() {
    return 'tab-probe';
  }
  getTabList() {
    return [{ id: 'tab-probe', url: 'https://admin.haravan.com' }];
  }
  getSharedProfilePartition() {
    return TARGET_PARTITION;
  }
  isValidCapsulePartition() {
    return true;
  }
  getActiveTabSession() {
    return this.session;
  }
  getTabSession() {
    return this.session;
  }
  getPartitionSession() {
    return this.session;
  }
}

const BATCH = [
  { name: 'SID', value: 'google-sid', domain: '.google.com' },
  { name: '__Secure-3PSID', value: 'google-3psid', domain: '.google.com', secure: true },
  { name: 'PREF', value: 'yt-pref', domain: '.youtube.com' },
  { name: 'evil_tracker', value: 'out-of-scope', domain: '.evil.test' },
];

(async () => {
  console.log('DEFAULT_EXTENSION_ALLOWED_DOMAINS =', JSON.stringify(DEFAULT_EXTENSION_ALLOWED_DOMAINS));

  const host = new MockTabHost();
  const server = new BridgeServer(host, 0);
  const port = await server.start();

  try {
    // Default grant: exactly what the app mints for the companion extension.
    const grant = server.issueExtensionGrant(TARGET_PARTITION);

    const res = await fetch(`http://127.0.0.1:${port}/api/cookies/import`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${grant.grantToken}`,
      },
      body: JSON.stringify({ targetPartition: TARGET_PARTITION, cookies: BATCH }),
    });
    const data = await res.json();

    const landed = host.cookieStore.setCalls.map((c) => `${c.name}@${c.domain}`);
    const googleLanded = landed.filter((e) => e.includes('google.com') || e.includes('youtube.com'));
    const outOfScopeLanded = landed.filter((e) => e.includes('evil.test'));

    console.log('HTTP', res.status, JSON.stringify(data));
    console.log('landed            =', JSON.stringify(landed));
    console.log('googleLandeds     =', JSON.stringify(googleLanded));
    console.log('outOfScopeLanded  =', JSON.stringify(outOfScopeLanded));
    console.log('VERDICT google_cookies_reachable =', googleLanded.length === 3);
    console.log('VERDICT out_of_scope_still_blocked =', outOfScopeLanded.length === 0);
  } finally {
    server.dispose();
  }
})().catch((err) => {
  console.error('probe failed:', err && err.stack ? err.stack : err);
  process.exit(1);
});
