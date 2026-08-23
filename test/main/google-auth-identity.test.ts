import test from 'node:test';
import assert from 'node:assert/strict';
import { googleAuthUserAgent, isGoogleAuthUrl, setUserAgentHeader, stripClientHints } from '../../src/main/browser/google-auth-identity';

test('Google auth identity is scoped to exact auth hosts', () => {
  assert.equal(isGoogleAuthUrl('https://accounts.google.com/v3/signin/identifier'), true);
  assert.equal(isGoogleAuthUrl('https://accounts.youtube.com/signin'), true);
  assert.equal(isGoogleAuthUrl('https://mail.google.com/'), false);
  assert.equal(isGoogleAuthUrl('https://accounts.google.com.evil.test/'), false);
});

test('Google auth identity uses consistent Chromium headers without duplicates', () => {
  const headers = { 'user-agent': 'old', 'Sec-CH-UA': 'Chromium', 'sec-ch-ua-platform': 'Windows' };
  setUserAgentHeader(headers, googleAuthUserAgent());
  stripClientHints(headers);
  assert.match(headers['user-agent'], /Chrome\/\d+\.\d+\.\d+\.\d+/);
  assert.doesNotMatch(headers['user-agent'], /Firefox/);
  assert.equal(Object.keys(headers).some((key) => key.toLowerCase().startsWith('sec-ch-ua')), false);
  assert.equal(Object.keys(headers).filter((key) => key.toLowerCase() === 'user-agent').length, 1);
});
