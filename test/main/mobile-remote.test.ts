import { test } from 'node:test';
import * as assert from 'node:assert/strict';
import { getLocalLanIps } from '../../src/main/bridge/bridge-server';
import { generateQrSvg } from '../../src/main/bridge/qr-generator';
import { renderMobileRemoteHtml } from '../../src/main/bridge/mobile-remote-html';

test('getLocalLanIps returns at least one valid IPv4 address', () => {
  const ips = getLocalLanIps();
  assert.ok(Array.isArray(ips));
  assert.ok(ips.length > 0);
  for (const ip of ips) {
    assert.match(ip, /^\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3}$/);
  }
});

test('generateQrSvg creates a valid clean standard SVG QR Code for short and long URLs', () => {
  const shortUrl = 'http://192.168.1.5:20130/?token=abc';
  const longUrl = 'http://192.168.1.50:20130/?token=78a83d7f90c8129e7162534f9a0b1c2d3e4f5';
  const svgShort = generateQrSvg(shortUrl, 240);
  const svgLong = generateQrSvg(longUrl, 240);
  assert.ok(typeof svgShort === 'string');
  assert.ok(svgShort.startsWith('<svg'));
  assert.ok(svgShort.includes('fill="#ffffff"'));
  assert.ok(svgShort.includes('fill="#0a0f1d"'));

  assert.ok(typeof svgLong === 'string');
  assert.ok(svgLong.startsWith('<svg'));
  assert.ok(svgLong.includes('</svg>'));
});

test('renderMobileRemoteHtml generates complete Pure Mobile Remote Terminal HTML', () => {
  const port = 20129;
  const html = renderMobileRemoteHtml(port);

  assert.ok(typeof html === 'string');
  assert.ok(html.includes('<!DOCTYPE html>'));
  assert.ok(html.includes('AntiFan Mobile Terminal'));
  assert.ok(html.includes('view-terminal'));
  assert.ok(html.includes('termSessionsStrip'));
  assert.ok(html.includes('terminalScreen'));
  assert.ok(html.includes('virtual-keypad'));
  assert.ok(html.includes('ansiToHtml'));
  assert.ok(html.includes('sendKey'));
  assert.ok(html.includes('ctrl_c'));
  assert.ok(html.includes('antifan.getTerminalSessions'));
  assert.ok(html.includes('antifan.terminalInput'));
  assert.ok(html.includes('antifan.terminalSendKey'));
  assert.ok(html.includes('antifan.terminalSwitchSession'));
  assert.ok(html.includes('antifan.terminalNewSession'));
  assert.ok(html.includes('antifan.terminalCloseSession'));
  assert.ok(html.includes('antifan.terminalRenameSession'));
  assert.ok(html.includes('btnModeToggle'));
  assert.ok(html.includes('terminalInput'));
  assert.ok(html.includes('initWebSocket'));
  // Dual-plane pairing contract (Phase 4): the mobile companion must NOT embed the
  // bridge master token into HTML; pairing happens via a bounded loopback code + WS subprotocol.
  assert.ok(html.includes('pairingCodeInput'), 'Mobile HTML must render the pairing code input');
  assert.ok(html.includes('pairingSubmitBtn') || html.includes('Ghép Nối'), 'Mobile HTML must render the pairing submit action');
  assert.ok(!html.includes('sample-bridge-token-xyz'), 'Mobile HTML must not embed a provided token literal');
  assert.ok(html.includes('antifan_mobile_token'), 'Mobile HTML must reference sessionStorage token for subprotocol auth, never a URL query token');
});
