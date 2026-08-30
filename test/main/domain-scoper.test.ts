import test from 'node:test';
import assert from 'node:assert/strict';
import {
  extractEtldPlusOne,
  isCookieInScope,
  SCOPE_PROFILES,
} from '../../src/extension/domain-scoper';

test('extractEtldPlusOne: extracts correct eTLD+1 for complex domains', () => {
  assert.equal(extractEtldPlusOne('https://admin.haravan.com'), 'haravan.com');
  assert.equal(extractEtldPlusOne('sub.store.myshopify.com'), 'store.myshopify.com');
  assert.equal(extractEtldPlusOne('my-shop.myshopify.com'), 'my-shop.myshopify.com');
  assert.equal(extractEtldPlusOne('accounts.google.com'), 'google.com');
  assert.equal(extractEtldPlusOne('myaccount.google.com.vn'), 'google.com.vn');
  assert.equal(extractEtldPlusOne('store.sapo.vn'), 'sapo.vn');
  assert.equal(extractEtldPlusOne('localhost'), 'localhost');
  assert.equal(extractEtldPlusOne('127.0.0.1'), '127.0.0.1');
  assert.equal(extractEtldPlusOne('::1'), '::1');
  assert.equal(extractEtldPlusOne('https://app.example.com:8443/dashboard?tab=1'), 'example.com');
  assert.equal(extractEtldPlusOne('http://localhost:3000/api'), 'localhost');
  assert.equal(extractEtldPlusOne('https://sub.xn--fiqs8s.cn'), 'xn--fiqs8s.cn');
  assert.equal(extractEtldPlusOne(null), null);
  assert.equal(extractEtldPlusOne(''), null);
});

test('isCookieInScope: matches Google profile domains', () => {
  assert.ok(isCookieInScope({ domain: '.google.com', name: 'SID' }, ['google']));
  assert.ok(isCookieInScope({ domain: 'accounts.google.com', name: 'LSID' }, ['google']));
  assert.ok(isCookieInScope({ domain: '.youtube.com', name: 'LOGIN_INFO' }, ['google']));
  assert.ok(isCookieInScope({ domain: '.googleusercontent.com', name: 'OTZ' }, ['google']));
  assert.ok(isCookieInScope({ domain: 'google.com.vn', name: 'NID' }, ['google']));
  assert.strictEqual(isCookieInScope({ domain: 'facebook.com', name: 'c_user' }, ['google']), false);
});

test('isCookieInScope: matches E-Commerce platform profile domains', () => {
  assert.ok(isCookieInScope({ domain: '.haravan.com', name: 'haravan_session' }, ['ecommerce']));
  assert.ok(isCookieInScope({ domain: 'my-store.myharavan.com', name: 'auth_token' }, ['ecommerce']));
  assert.ok(isCookieInScope({ domain: '.shopify.com', name: '_shopify_s' }, ['ecommerce']));
  assert.ok(isCookieInScope({ domain: 'store.myshopify.com', name: '_master_session' }, ['ecommerce']));
  assert.ok(isCookieInScope({ domain: '.sapo.vn', name: 'sapo_token' }, ['ecommerce']));
  assert.ok(isCookieInScope({ domain: 'admin.bizweb.vn', name: 'bizweb_user' }, ['ecommerce']));
  assert.strictEqual(isCookieInScope({ domain: 'random-blog.com', name: 'visitor' }, ['ecommerce']), false);
});

test('isCookieInScope: matches active tab eTLD+1 dynamically', () => {
  const activeTabHost = 'my-custom-saas.com';
  // Matching active tab
  assert.ok(isCookieInScope({ domain: '.my-custom-saas.com', name: 'jwt' }, [], activeTabHost));
  assert.ok(isCookieInScope({ domain: 'api.my-custom-saas.com', name: 'session' }, [], activeTabHost));
  
  // Unrelated domain when profile disabled
  assert.strictEqual(
    isCookieInScope({ domain: 'other-site.com', name: 'tracking' }, [], activeTabHost),
    false
  );
});

test('isCookieInScope: matches custom user domains', () => {
  assert.ok(
    isCookieInScope(
      { domain: 'internal-portal.corp.net', name: 'sso_auth' },
      [],
      null,
      ['corp.net']
    )
  );
});
