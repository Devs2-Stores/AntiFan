import { describe, it } from 'node:test';
import * as assert from 'node:assert';
import {
  OAuthPopupManager,
  describeWindowOpen,
  type OAuthWindowOpenDecision,
} from '../../src/main/browser/oauth-popup-manager';

type Details = { url: string; disposition?: string; features?: string; frameName?: string };

function open(
  details: Details,
  handlers: { popup?: boolean; newTab?: boolean } = { popup: true, newTab: true }
): { response: { action: string }; decisions: OAuthWindowOpenDecision[]; tabs: string[] } {
  const decisions: OAuthWindowOpenDecision[] = [];
  const tabs: string[] = [];
  const response = OAuthPopupManager.getInstance().handleWindowOpen(
    { frameName: '', features: '', disposition: 'foreground-tab', ...details } as never,
    {
      ...(handlers.popup ? { createOAuthPopup: () => ({}) as never } : {}),
      ...(handlers.newTab ? { onNewTabRequested: (url: string) => { tabs.push(url); } } : {}),
      onDecision: (decision) => decisions.push(decision),
    }
  );
  return { response: response as { action: string }, decisions, tabs };
}

describe('window.open decision journal', () => {
  it('reports host and path only, never the query or fragment', () => {
    const { decisions } = open({
      url: 'https://accounts.google.com/o/oauth2/v2/auth?client_id=SECRETID&state=SECRETSTATE#access_token=SECRETTOKEN',
    });
    assert.strictEqual(decisions.length, 1);
    assert.strictEqual(decisions[0]!.decision, 'oauth-popup');
    assert.strictEqual(decisions[0]!.host, 'accounts.google.com');
    assert.strictEqual(decisions[0]!.path, '/o/oauth2/v2/auth');
    assert.ok(!JSON.stringify(decisions[0]).includes('SECRET'), 'no part of the query or fragment is journaled');
  });

  it('journals the scheme only for a refused non-http URL', () => {
    const { response, decisions } = open({ url: 'javascript:alert("SECRETPAYLOAD")' });
    assert.strictEqual(response.action, 'deny');
    assert.strictEqual(decisions[0]!.decision, 'deny-scheme');
    assert.strictEqual(decisions[0]!.host, '');
    assert.strictEqual(decisions[0]!.path, '');
    assert.ok(!JSON.stringify(decisions[0]).includes('SECRETPAYLOAD'));
  });

  it('journals the new-tab branch and the no-handler branch', () => {
    const tab = open({ url: 'https://example.com/docs?x=1' });
    assert.strictEqual(tab.decisions[0]!.decision, 'new-tab');
    assert.deepStrictEqual(tab.tabs, ['https://example.com/docs?x=1']);

    const none = open({ url: 'https://example.com/docs' }, {});
    assert.strictEqual(none.response.action, 'deny');
    assert.strictEqual(none.decisions[0]!.decision, 'deny-no-handler');

    const noBuilder = open({ url: 'https://accounts.google.com/o/oauth2/v2/auth' }, { newTab: true });
    assert.strictEqual(noBuilder.response.action, 'deny');
    assert.strictEqual(noBuilder.decisions[0]!.decision, 'deny-no-handler');
  });

  it('records disposition, features presence and a truncated frame name', () => {
    const { decisions } = open({
      url: 'https://example.com/a',
      disposition: 'new-window',
      features: 'width=10',
      frameName: 'x'.repeat(200),
    }, { newTab: true });
    assert.strictEqual(decisions[0]!.disposition, 'new-window');
    assert.strictEqual(decisions[0]!.hasFeatures, true);
    assert.strictEqual(decisions[0]!.frameName.length, 64);
  });

  it('a throwing journal never changes the window.open answer', () => {
    const response = OAuthPopupManager.getInstance().handleWindowOpen(
      { url: 'https://example.com/a', frameName: '', features: '', disposition: 'foreground-tab' } as never,
      { onDecision: () => { throw new Error('journal down'); }, onNewTabRequested: () => {} }
    );
    assert.strictEqual(response.action, 'deny');
  });

  it('describeWindowOpen tolerates an unparseable URL', () => {
    const d = describeWindowOpen({ url: 'not a url' } as never, 'deny-scheme');
    assert.strictEqual(d.host, '');
    assert.strictEqual(d.path, '');
  });
});

describe('Instagram and Meta Business sign-in popups', () => {
  it('classifies the login and authorize paths as OAuth popups', () => {
    const manager = OAuthPopupManager.getInstance();
    for (const url of [
      'https://www.instagram.com/accounts/login/?next=/oauth/authorize',
      'https://www.instagram.com/oauth/authorize?client_id=1',
      'https://business.facebook.com/login/?next=x',
      'https://business.facebook.com/oauth/authorize',
      'https://business.facebook.com/oidc/?state=1',
    ]) {
      assert.strictEqual(manager.isOAuthUrl(url), true, `expected OAuth URL: ${url}`);
      assert.strictEqual(open({ url }).response.action, 'allow');
    }
    for (const url of [
      'https://www.instagram.com/someaccount/',
      'https://business.facebook.com/latest/home',
      'https://attacker.example/business.facebook.com/login',
    ]) {
      assert.strictEqual(manager.isOAuthUrl(url), false, `expected ordinary URL: ${url}`);
    }
  });
});

describe('sized https window.open keeps its opener', () => {
  it('hosts a window.open with width features as a popup even for an unlisted host', () => {
    const { response, decisions, tabs } = open({
      url: 'https://shop.example/connect/facebook?token=SECRET',
      disposition: 'new-window',
      features: 'width=600,height=700,left=10',
    });
    assert.strictEqual(response.action, 'allow');
    assert.strictEqual(decisions[0]!.decision, 'feature-popup');
    assert.deepStrictEqual(tabs, []);
    assert.ok(!JSON.stringify(decisions[0]).includes('SECRET'));
  });

  it('hosts a window.open with the popup feature', () => {
    for (const features of ['popup', 'popup=yes', 'popup=1,width=400']) {
      assert.strictEqual(
        open({ url: 'https://shop.example/x', disposition: 'new-window', features }).response.action,
        'allow',
        features
      );
    }
  });

  it('keeps denying a new-window without features and a features-less link', () => {
    const noFeatures = open({ url: 'https://shop.example/x', disposition: 'new-window' });
    assert.strictEqual(noFeatures.response.action, 'deny');
    assert.strictEqual(noFeatures.decisions[0]!.decision, 'new-tab');
    const link = open({ url: 'https://shop.example/x', disposition: 'foreground-tab' });
    assert.strictEqual(link.response.action, 'deny');
  });

  it('does not host noopener, non-https, popup=no or builderless requests', () => {
    for (const details of [
      { url: 'https://shop.example/x', disposition: 'new-window', features: 'noopener,width=600' },
      { url: 'http://shop.example/x', disposition: 'new-window', features: 'width=600' },
      { url: 'https://shop.example/x', disposition: 'new-window', features: 'popup=no' },
      { url: 'https://shop.example/x', disposition: 'foreground-tab', features: 'width=600' },
    ]) {
      const result = open(details);
      assert.strictEqual(result.response.action, 'deny', JSON.stringify(details));
      assert.strictEqual(result.decisions[0]!.decision, 'new-tab', JSON.stringify(details));
    }
    const builderless = open(
      { url: 'https://shop.example/x', disposition: 'new-window', features: 'width=600' },
      { newTab: true }
    );
    assert.strictEqual(builderless.decisions[0]!.decision, 'new-tab', 'falls back to the tab route when no popup builder exists');
  });
});
