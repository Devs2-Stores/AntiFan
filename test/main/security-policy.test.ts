import { describe, it } from 'node:test';
import * as assert from 'node:assert';
import { isAllowedNavigation, sanitizeUrl, getSecureWebPreferences, cleanRestoredUrl } from '../../src/main/security/security-policy';

describe('AntiFan Security Policy', () => {
  it('allows standard https, http, and safe view-source urls', () => {
    assert.strictEqual(isAllowedNavigation('https://google.com'), true);
    assert.strictEqual(isAllowedNavigation('http://localhost:3000'), true);
    assert.strictEqual(isAllowedNavigation('about:blank'), true);
    assert.strictEqual(isAllowedNavigation('view-source:https://example.com'), true);
    assert.strictEqual(isAllowedNavigation('view-source:http://localhost:8080/test'), true);
  });

  it('blocks dangerous schemes like file, javascript, data, and unsafe view-source schemes', () => {
    assert.strictEqual(isAllowedNavigation('file:///C:/Windows/System32/cmd.exe'), false);
    assert.strictEqual(isAllowedNavigation('javascript:alert(1)'), false);
    assert.strictEqual(isAllowedNavigation('data:text/html,<h1>Hacked</h1>'), false);
    assert.strictEqual(isAllowedNavigation('chrome://settings'), false);
    assert.strictEqual(isAllowedNavigation('view-source:javascript:alert(1)'), false);
    assert.strictEqual(isAllowedNavigation('view-source:file:///C:/passwords.txt'), false);
    assert.strictEqual(isAllowedNavigation('view-source:data:text/html,<h1>XSS</h1>'), false);
  });

  it('sanitizes user input into valid URLs', () => {
    assert.strictEqual(sanitizeUrl('example.com'), 'https://example.com');
    assert.strictEqual(sanitizeUrl('https://github.com'), 'https://github.com');
    assert.strictEqual(sanitizeUrl('HTTP://localhost:3000'), 'HTTP://localhost:3000');
    assert.strictEqual(sanitizeUrl('HTTPS://example.com'), 'HTTPS://example.com');
    assert.strictEqual(sanitizeUrl('hello world'), 'https://www.google.com/search?q=hello%20world');
    assert.strictEqual(sanitizeUrl(''), 'about:blank');
    assert.strictEqual(sanitizeUrl('ABOUT:BLANK'), 'ABOUT:BLANK');
    assert.strictEqual(sanitizeUrl('file:///C:/passwords.txt'), 'about:blank');
    assert.strictEqual(sanitizeUrl('javascript:alert(1)'), 'about:blank');
    assert.strictEqual(sanitizeUrl('data:text/html,<h1>bad</h1>'), 'about:blank');
    assert.strictEqual(sanitizeUrl('view-source:https://example.com'), 'view-source:https://example.com/');
    assert.strictEqual(sanitizeUrl('view-source:javascript:alert(1)'), 'about:blank');
  });
  it('cleans Google error and CookieMismatch URLs', () => {
    assert.strictEqual(cleanRestoredUrl('https://accounts.google.com/CookieMismatch'), 'https://www.google.com');
    assert.strictEqual(cleanRestoredUrl('https://accounts.google.com/CookieMismatch?continue=https://google.com'), 'https://www.google.com');
    assert.strictEqual(cleanRestoredUrl('https://www.google.com/search?q=test'), 'https://www.google.com/search?q=test');
  });
  it('enforces secure webPreferences sandbox', () => {
    const prefs = getSecureWebPreferences();
    assert.strictEqual(prefs.contextIsolation, false);
    assert.strictEqual(prefs.sandbox, true);
    assert.strictEqual(prefs.nodeIntegration, false);
    assert.strictEqual(prefs.webSecurity, true);
    assert.strictEqual(prefs.backgroundThrottling, true);
  });
  it('attaches partition string when provided to getSecureWebPreferences', () => {
    const prefs = getSecureWebPreferences('persist:capsule-workspace-1');
    assert.strictEqual(prefs.partition, 'persist:capsule-workspace-1');
    assert.strictEqual(prefs.contextIsolation, false);
    assert.strictEqual(prefs.sandbox, true);
  });
});