import { describe, it } from 'node:test';
import * as assert from 'node:assert';
import { OAuthPopupManager } from '../../src/main/browser/oauth-popup-manager';

describe('OAuthPopupManager Invariants', () => {
  it('correctly identifies OAuth authorization URLs', () => {
    const manager = OAuthPopupManager.getInstance();

    assert.strictEqual(manager.isOAuthUrl('https://accounts.google.com/o/oauth2/v2/auth?client_id=123'), true);
    assert.strictEqual(manager.isOAuthUrl('https://accounts.google.com/signin/oauth/consent'), true);
    assert.strictEqual(manager.isOAuthUrl('https://github.com/login/oauth/authorize?scope=user'), true);
    assert.strictEqual(manager.isOAuthUrl('https://auth.haravan.com/connect/authorize'), true);
    assert.strictEqual(manager.isOAuthUrl('https://accounts.shopify.com/oauth/authorize'), true);
    assert.strictEqual(manager.isOAuthUrl('https://myshopify.com/admin/oauth/authorize'), true);
    assert.strictEqual(manager.isOAuthUrl('https://sapo.vn/oauth/authorize'), true);
    assert.strictEqual(manager.isOAuthUrl('https://id.sapo.vn/login'), true);
    assert.strictEqual(manager.isOAuthUrl('https://accounts.sapo.vn/admin/oauth'), true);
    assert.strictEqual(manager.isOAuthUrl('https://login.microsoftonline.com/common/oauth2/v2.0/authorize'), true);
    assert.strictEqual(manager.isOAuthUrl('https://gitlab.com/oauth/authorize'), true);
    assert.strictEqual(manager.isOAuthUrl('https://linear.app/oauth/authorize'), true);
    // Non-OAuth URLs
    assert.strictEqual(manager.isOAuthUrl('https://www.google.com/search?q=test'), false);
    assert.strictEqual(manager.isOAuthUrl('https://github.com/stablyai/orca'), false);
    assert.strictEqual(manager.isOAuthUrl('https://vnexpress.net/thoi-su'), false);
  });

  it('correctly identifies OAuth callback URLs', () => {
    const manager = OAuthPopupManager.getInstance();

    assert.strictEqual(manager.isOAuthCallbackUrl('https://myapp.com/auth/callback?code=4/0AX4XfWh'), true);
    assert.strictEqual(manager.isOAuthCallbackUrl('https://app.haravan.com/oauth/callback?code=abc'), true);
    assert.strictEqual(manager.isOAuthCallbackUrl('https://localhost:3000/signin-google?code=xyz'), true);
    assert.strictEqual(manager.isOAuthCallbackUrl('https://sapo.vn/oauth/callback?code=def'), true);
    assert.strictEqual(manager.isOAuthCallbackUrl('https://mysite.com/auth/success'), true);
    assert.strictEqual(manager.isOAuthCallbackUrl('https://mysite.com/login/callback?state=123'), true);
    assert.strictEqual(manager.isOAuthCallbackUrl('https://google.com/news'), false);
  });
});
