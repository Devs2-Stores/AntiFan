import { describe, it } from 'node:test';
import * as assert from 'node:assert/strict';
import { classifyNetworkUrl } from './network-policy.js';

describe('Phase 2 & 4: Production Zero-External-Network Denial Policy & Host-Boundary Defense', () => {
  it('allows verified local hosts, IPv4/IPv6 loopbacks, and safe local protocols', () => {
    // Standard localhost with and without port
    assert.strictEqual(classifyNetworkUrl('http://localhost:8080/assets/style.css').action, 'allow');
    assert.strictEqual(classifyNetworkUrl('https://localhost:3000/app.js').action, 'allow');
    assert.strictEqual(classifyNetworkUrl('http://localhost/').action, 'allow');

    // IPv4 loopback
    assert.strictEqual(classifyNetworkUrl('http://127.0.0.1:20130/assets/banner.jpg').action, 'allow');
    assert.strictEqual(classifyNetworkUrl('https://127.0.0.1:8443/api').action, 'allow');

    // IPv6 loopback
    assert.strictEqual(classifyNetworkUrl('http://[::1]:8080/').action, 'allow');

    // Data, Blob, and local file URIs
    assert.strictEqual(classifyNetworkUrl('data:image/png;base64,iVBORw0KGgo=').action, 'allow');
    assert.strictEqual(classifyNetworkUrl('blob:http://localhost:3000/1234-5678').action, 'allow');
    assert.strictEqual(classifyNetworkUrl('file:///C:/Users/Admin/theme/index.html').action, 'allow');
    assert.strictEqual(classifyNetworkUrl('about:blank').action, 'allow');
  });

  it('strictly blocks prefix-match bypasses, remote domains, and remote file shares (SSRF Prevention)', () => {
    // Critical Host-Boundary Defense: must not prefix-match 'localhost.evil.com'
    const subDomainBypass1 = classifyNetworkUrl('http://localhost.evil.com/malicious.js');
    assert.strictEqual(subDomainBypass1.action, 'block');
    assert.strictEqual(subDomainBypass1.isLocal, false);
    assert.strictEqual(subDomainBypass1.hostname, 'localhost.evil.com');

    const subDomainBypass2 = classifyNetworkUrl('http://127.0.0.1.attacker.org/exfiltrate');
    assert.strictEqual(subDomainBypass2.action, 'block');
    assert.strictEqual(subDomainBypass2.isLocal, false);
    assert.strictEqual(subDomainBypass2.hostname, '127.0.0.1.attacker.org');

    // Remote external websites and CDNs
    assert.strictEqual(classifyNetworkUrl('https://img.hoplongtech.com/logo.png').action, 'block');
    assert.strictEqual(classifyNetworkUrl('https://fonts.googleapis.com/css2').action, 'block');
    assert.strictEqual(classifyNetworkUrl('https://cdn.hstatic.net/script.js').action, 'block');
    assert.strictEqual(classifyNetworkUrl('http://tracker.example.com/beacon').action, 'block');

    // Remote SMB/UNC file share
    const uncShare = classifyNetworkUrl('file://remote-server/share/file.txt');
    assert.strictEqual(uncShare.action, 'block');
    assert.strictEqual(uncShare.reason, 'REMOTE_FILE_SHARE');

    // Malformed and unsupported protocols
    assert.strictEqual(classifyNetworkUrl('gopher://127.0.0.1:70/').action, 'block');
    assert.strictEqual(classifyNetworkUrl('javascript:alert(1)').action, 'block');
    assert.strictEqual(classifyNetworkUrl('').action, 'block');
  });

  it('fail-closed interceptor enforcement: throws immediately if any external URL passes through interceptor', () => {
    const urlsToTest = [
      'http://localhost:3000/index.html',
      'http://localhost.evil.com/exploit.js', // must be blocked
      'https://127.0.0.1:20130/theme.js',
      'https://cdn.hstatic.net/tracker.js'   // must be blocked
    ];

    const interceptedBlocks: string[] = [];
    for (const u of urlsToTest) {
      const verdict = classifyNetworkUrl(u);
      if (verdict.action === 'block') {
        interceptedBlocks.push(u);
      }
    }

    // Must have exactly intercepted the two prohibited external domains
    assert.strictEqual(interceptedBlocks.length, 2);
    assert.ok(interceptedBlocks.includes('http://localhost.evil.com/exploit.js'));
    assert.ok(interceptedBlocks.includes('https://cdn.hstatic.net/tracker.js'));
  });
});
