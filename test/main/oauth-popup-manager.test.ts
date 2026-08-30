import { describe, it } from 'node:test';
import * as assert from 'node:assert';
import { OAuthPopupManager } from '../../src/main/browser/oauth-popup-manager';

describe('OAuthPopupManager Invariants', () => {
  it('classifies OAuth authorization URLs by parsed host and path', () => {
    const manager = OAuthPopupManager.getInstance();

    for (const url of [
      'https://accounts.google.com/o/oauth2/v2/auth?client_id=123',
      'https://www.facebook.com/dialog/oauth?client_id=456',
      'https://accounts.google.com/signin/oauth/consent',
      'https://github.com/login/oauth/authorize?scope=user',
      'https://auth.haravan.com/connect/authorize',
      'https://accounts.shopify.com/oauth/authorize',
      'https://store.myshopify.com/admin/oauth/authorize',
      'https://sapo.vn/oauth/authorize',
      'https://id.sapo.vn/login',
      'https://accounts.sapo.vn/admin/oauth',
      'https://login.microsoftonline.com/common/oauth2/v2.0/authorize',
      'https://gitlab.com/oauth/authorize',
      'https://linear.app/oauth/authorize',
      'https://trello.com/1/authorize?key=123&name=AntiFan',
      'https://trello.com/1/OAuthAuthorizeToken?oauth_token=token',
      'antifan-smoke://identity/oauth/authorize?client_id=smoke',
    ]) {
      assert.strictEqual(manager.isOAuthUrl(url), true, `expected OAuth URL: ${url}`);
    }

    for (const url of [
      'https://www.google.com/search?q=test',
      'https://github.com/stablyai/orca',
      'https://vnexpress.net/thoi-su',
      'https://attacker.example/?next=https://accounts.google.com/o/oauth2/v2/auth',
      'https://attacker.example/accounts.google.com/signin',
      'not a URL',
    ]) {
      assert.strictEqual(manager.isOAuthUrl(url), false, `expected ordinary URL: ${url}`);
    }
  });
  it('keeps website-owned OAuth in the parent Chromium session without requesting a tab', () => {
    const manager = OAuthPopupManager.getInstance();
    const sharedSession = { name: 'shared-session' };
    const parentContents = { session: sharedSession };
    const parentWindow = { name: 'parent-window' };
    const opened: string[] = [];

    for (const url of [
      'https://accounts.google.com/o/oauth2/v2/auth?client_id=123',
      'https://www.facebook.com/v20.0/dialog/oauth?client_id=456',
      'https://www.facebook.com/dialog/oauth?client_id=456',
      'https://github.com/login/oauth/authorize?scope=user',
      'https://auth.haravan.com/connect/authorize',
      'https://accounts.shopify.com/oauth/authorize',
      'https://sapo.vn/oauth/authorize',
      'https://login.microsoftonline.com/common/oauth2/v2.0/authorize',
      'https://trello.com/1/authorize?key=123',
    ]) {
      const result = manager.handleWindowOpen(
        parentContents as never,
        parentWindow as never,
        { url } as never,
        { onNewTabRequested: (requestedUrl) => opened.push(requestedUrl) }
      );
      assert.strictEqual(result.action, 'allow');
      assert.strictEqual(result.overrideBrowserWindowOptions?.parent, parentWindow);
      assert.strictEqual(result.overrideBrowserWindowOptions?.webPreferences?.session, sharedSession);
      assert.strictEqual(result.overrideBrowserWindowOptions?.webPreferences?.sandbox, true);
      assert.strictEqual(result.overrideBrowserWindowOptions?.webPreferences?.nodeIntegration, false);
      assert.strictEqual(result.overrideBrowserWindowOptions?.webPreferences?.contextIsolation, false);
    }
    assert.deepEqual(opened, []);
  });

  it('routes ordinary HTTP popups to an AntiFan tab without opening an OS browser', () => {
    const manager = OAuthPopupManager.getInstance();
    const opened: string[] = [];
    const result = manager.handleWindowOpen(
      { session: {} } as never,
      {} as never,
      { url: 'https://example.com/docs' } as never,
      { onNewTabRequested: (url) => opened.push(url) }
    );
    assert.strictEqual(result.action, 'deny');
    assert.deepEqual(opened, ['https://example.com/docs']);
  });

  it('identifies OAuth callbacks by parsed pathname without closing ordinary stateful URLs', () => {
    const manager = OAuthPopupManager.getInstance();

    for (const url of [
      'https://myapp.com/auth/callback?code=4/0AX4XfWh',
      'https://app.haravan.com/oauth/callback?code=abc',
      'https://localhost:3000/signin-google?code=xyz',
      'https://sapo.vn/oauth/callback?code=def',
      'https://mysite.com/auth/success',
      'https://mysite.com/login/callback?state=123',
    ]) {
      assert.strictEqual(manager.isOAuthCallbackUrl(url), true, `expected OAuth callback: ${url}`);
    }

    for (const url of [
      'https://google.com/news',
      'https://example.com/?state=active',
      'https://example.com/article?code=abc',
      'https://attacker.example/?next=https://myapp.com/auth/callback?code=abc',
      'https://attacker.example/oauth/callback-lookalike?code=abc',
      'not a URL',
    ]) {
      assert.strictEqual(manager.isOAuthCallbackUrl(url), false, `expected ordinary URL: ${url}`);
    }
  });
});
