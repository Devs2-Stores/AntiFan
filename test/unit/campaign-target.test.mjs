import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  resolveCampaignBaseUrl,
  campaignReferenceHosts,
  buildCampaignTargetPages,
  CAMPAIGN_PAGE_SPECS,
  DEFAULT_CAMPAIGN_BASE_URL,
} from '../../scripts/lib/campaign-target.mjs';
import { checkObservedUrl } from '../../.canary/tools/theme-fidelity.mjs';

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const RUNNER = path.join(REPO, '.canary', 'tools', 'fifteen-pages-run.mjs');

const printConfig = (env = {}, args = []) =>
  JSON.parse(execFileSync(process.execPath, [RUNNER, '--print-config', ...args], {
    cwd: REPO,
    env: { ...process.env, ...env },
    encoding: 'utf8',
  }));

test('the default target is the hangquoctai store', () => {
  const resolved = resolveCampaignBaseUrl({ argv: [], env: {} });
  assert.equal(resolved.baseUrl, 'https://hangquoctai.myharavan.com');
  assert.equal(resolved.host, 'hangquoctai.myharavan.com');
  assert.equal(resolved.source, 'default');
});

test('ANTIFAN_CAMPAIGN_BASE_URL re-points the whole page set', () => {
  const resolved = resolveCampaignBaseUrl({ argv: [], env: { ANTIFAN_CAMPAIGN_BASE_URL: 'https://other-store.example.com/base/' } });
  assert.equal(resolved.baseUrl, 'https://other-store.example.com');
  assert.equal(resolved.source, 'env');

  const pages = buildCampaignTargetPages(resolved.baseUrl);
  assert.equal(pages.length, 15);
  for (const p of pages) {
    assert.ok(p.url.startsWith('https://other-store.example.com/'), `${p.slug} must be under the env base`);
    assert.equal(p.domain, 'other-store.example.com', `${p.slug} domain must derive from the base`);
  }
});

test('--base-url wins over the environment', () => {
  const resolved = resolveCampaignBaseUrl({
    argv: ['--pages', '3', '--base-url', 'https://flag.example.com?x=1'],
    env: { ANTIFAN_CAMPAIGN_BASE_URL: 'https://env.example.com' },
  });
  assert.equal(resolved.baseUrl, 'https://flag.example.com');
  assert.equal(resolved.source, 'flag');
});

test('a malformed target refuses instead of measuring the wrong subject', () => {
  for (const bad of ['not-a-url', 'ftp://x.example.com']) {
    assert.throws(
      () => resolveCampaignBaseUrl({ argv: [], env: { ANTIFAN_CAMPAIGN_BASE_URL: bad } }),
      (err) => err.code === 'INVALID_CAMPAIGN_BASE_URL',
      `${JSON.stringify(bad)} must throw INVALID_CAMPAIGN_BASE_URL`
    );
  }
  // An empty env var is unset, not malformed: it falls back to the default.
  assert.equal(resolveCampaignBaseUrl({ argv: [], env: { ANTIFAN_CAMPAIGN_BASE_URL: '' } }).source, 'default');
});

test('the locked page set covers the storefront intents on real routes', () => {
  const pages = buildCampaignTargetPages(DEFAULT_CAMPAIGN_BASE_URL);
  assert.equal(pages.length, CAMPAIGN_PAGE_SPECS.length);
  assert.equal(new Set(pages.map((p) => p.id)).size, 15);
  assert.equal(new Set(pages.map((p) => p.slug)).size, 15);

  const byPath = Object.fromEntries(pages.map((p) => [new URL(p.url).pathname + new URL(p.url).search, p]));
  for (const route of ['/', '/collections/all', '/collections/hot-products', '/cart', '/account',
    '/account/login', '/blogs/news', '/pages/about-us', '/pages/chinh-sach-doi-tra',
    '/pages/chinh-sach-bao-mat', '/pages/wishlist', '/search?q=a']) {
    assert.ok(byPath[route], `missing route ${route}`);
  }
  assert.ok(pages.some((p) => p.url.includes('/products/')), 'a product detail page is required');
  assert.ok(pages.some((p) => /\/blogs\/news\/.+/.test(new URL(p.url).pathname)), 'an article detail page is required');
  assert.ok(pages.some((p) => p.url.includes('sort=')), 'a sorted/filtered listing is required');
});

test('reference hosts cover the target host and the platform asset CDNs', () => {
  const hosts = campaignReferenceHosts('hangquoctai.myharavan.com');
  assert.ok(hosts.includes('hangquoctai.myharavan.com'));
  for (const platform of ['hstatic.net', 'dktcdn.net', 'myharavan.com', 'haravan.com']) {
    assert.ok(hosts.includes(platform), `missing platform asset host ${platform}`);
  }
  assert.equal(new Set(hosts).size, hosts.length, 'no duplicate hosts');

  const other = campaignReferenceHosts('shop.example.com');
  assert.ok(other.includes('shop.example.com'), 'a re-targeted host is audited too');
});

test('a guest /account redirect is a route refusal, never a PASS', () => {
  const target = { name: 'TÀI KHOẢN', url: 'https://hangquoctai.myharavan.com/account' };
  const refusal = checkObservedUrl(target, 'https://hangquoctai.myharavan.com/account/login');
  assert.ok(refusal, 'the redirect must produce a refusal');
  assert.equal(refusal.code, 'URL_PATH_MISMATCH');

  // The public cart serves its own route on this store, so the gate must not refuse it.
  const cart = checkObservedUrl({ name: 'GIỎ HÀNG', url: 'https://hangquoctai.myharavan.com/cart' }, 'https://hangquoctai.myharavan.com/cart');
  assert.equal(cart, null, 'a same-route observation is not a refusal');
});

test('--print-config resolves the default target without a session or browser', () => {
  const config = printConfig();
  assert.equal(config.baseUrl, 'https://hangquoctai.myharavan.com');
  assert.equal(config.source, 'default');
  assert.equal(config.pages.length, 15);
  assert.ok(config.pages.every((p) => p.domain === 'hangquoctai.myharavan.com'));
  assert.ok(!JSON.stringify(config).includes('hoplong'), 'no previous-store host survives in the resolved config');
});

test('--print-config honors the env var end to end', () => {
  const config = printConfig({ ANTIFAN_CAMPAIGN_BASE_URL: 'https://env-probe.example.com' });
  assert.equal(config.baseUrl, 'https://env-probe.example.com');
  assert.equal(config.source, 'env');
  assert.ok(config.pages.every((p) => p.url.startsWith('https://env-probe.example.com/')));
  assert.ok(config.referenceHosts.includes('env-probe.example.com'));
});

test('--help prints usage and the resolved target, then exits 0', () => {
  const out = execFileSync(process.execPath, [RUNNER, '--help'], { cwd: REPO, encoding: 'utf8' });
  assert.match(out, /--base-url/);
  assert.match(out, /hangquoctai\.myharavan\.com/);
  assert.match(out, /--print-config/);
});
