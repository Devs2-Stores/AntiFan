import { describe, it } from 'node:test';
import * as assert from 'node:assert';
import { isAllowedNavigation, sanitizeUrl, getSecureWebPreferences } from '../../src/main/security/security-policy';

describe('AntiFan Security Policy', () => {
  it('allows standard https and http urls', () => {
    assert.strictEqual(isAllowedNavigation('https://google.com'), true);
    assert.strictEqual(isAllowedNavigation('http://localhost:3000'), true);
    assert.strictEqual(isAllowedNavigation('about:blank'), true);
  });

  it('blocks dangerous schemes like file, javascript, data', () => {
    assert.strictEqual(isAllowedNavigation('file:///C:/Windows/System32/cmd.exe'), false);
    assert.strictEqual(isAllowedNavigation('javascript:alert(1)'), false);
    assert.strictEqual(isAllowedNavigation('data:text/html,<h1>Hacked</h1>'), false);
    assert.strictEqual(isAllowedNavigation('chrome://settings'), false);
  });

  it('sanitizes user input into valid URLs', () => {
    assert.strictEqual(sanitizeUrl('example.com'), 'https://example.com');
    assert.strictEqual(sanitizeUrl('https://github.com'), 'https://github.com');
    assert.strictEqual(sanitizeUrl('hello world'), 'https://www.google.com/search?q=hello%20world');
    assert.strictEqual(sanitizeUrl(''), 'about:blank');
  });

  it('enforces secure webPreferences sandbox', () => {
    const prefs = getSecureWebPreferences();
    assert.strictEqual(prefs.contextIsolation, true);
    assert.strictEqual(prefs.sandbox, true);
    assert.strictEqual(prefs.nodeIntegration, false);
    assert.strictEqual(prefs.webSecurity, true);
  });
});