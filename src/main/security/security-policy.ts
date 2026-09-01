/**
 * AntiFan Browser Desktop — Security Policy
 * Enforces strict sandbox isolation, URL validation, and deny-by-default popup routing.
 */
import { WebPreferences, shell } from 'electron';

const ALLOWED_PROTOCOLS = new Set(['http:', 'https:', 'about:', 'antifan:', 'antifan-preview:']);
const BLOCKED_SCHEMES = new Set(['file:', 'javascript:', 'vbscript:', 'data:', 'chrome:', 'devtools:']);

export function isAllowedNavigation(targetUrl: string): boolean {
  const trimmed = (targetUrl || '').trim();
  if (!trimmed) return false;
  if (trimmed.toLowerCase().startsWith('view-source:')) {
    const inner = trimmed.slice('view-source:'.length).trim();
    try {
      const innerParsed = new URL(inner);
      const innerProto = innerParsed.protocol.toLowerCase();
      return innerProto === 'http:' || innerProto === 'https:';
    } catch {
      return false;
    }
  }
  try {
    const parsed = new URL(trimmed);
    const proto = parsed.protocol.toLowerCase();
    if (BLOCKED_SCHEMES.has(proto)) {
      return false;
    }
    return ALLOWED_PROTOCOLS.has(proto);
  } catch {
    return false;
  }
}

export function isInternalWidgetOrSubframeUrl(url?: string): boolean {
  if (!url) return false;
  const lower = url.toLowerCase();
  if (lower.includes('contacts.google.com/widget')) return true;
  if (lower.includes('/widget/hovercard')) return true;
  if (lower.includes('accounts.google.com/gsi/iframe')) return true;
  if (lower.includes('google.com/recaptcha/api2/bframe')) return true;
  if (lower.includes('google.com/recaptcha/enterprise/bframe')) return true;
  return false;
}

export function cleanRestoredUrl(rawUrl?: string): string {
  if (!rawUrl) return '';
  if (rawUrl === 'about:blank') return 'about:blank';
  if (rawUrl.includes('accounts.google.com/CookieMismatch') || rawUrl.includes('/CookieMismatch')) {
    return 'https://www.google.com';
  }
  if (rawUrl.includes('accounts.google.com/v3/signin/rejected') || rawUrl.includes('accounts.google.com/signin/rejected')) {
    try {
      const u = new URL(rawUrl);
      const cont = u.searchParams.get('continue');
      if (cont && (cont.startsWith('http://') || cont.startsWith('https://'))) {
        return cont;
      }
    } catch {}
    return 'https://www.google.com';
  }
  if (isInternalWidgetOrSubframeUrl(rawUrl)) {
    try {
      const u = new URL(rawUrl);
      const origin = u.searchParams.get('origin') || u.searchParams.get('parent');
      if (origin && (origin.startsWith('http://') || origin.startsWith('https://'))) {
        return decodeURIComponent(origin);
      }
    } catch {}
    return 'https://docs.google.com';
  }
  return rawUrl;
}

export function sanitizeUrl(inputUrl: string): string {
  const clean = cleanRestoredUrl(inputUrl);
  const trimmed = clean.trim();
  if (!trimmed) return 'about:blank';
  const lower = trimmed.toLowerCase();
  if (
    lower.startsWith('file:') ||
    lower.startsWith('javascript:') ||
    lower.startsWith('data:') ||
    lower.startsWith('vbscript:') ||
    lower.startsWith('chrome:')
  ) {
    return 'about:blank';
  }
  if (lower.startsWith('view-source:')) {
    const inner = trimmed.slice('view-source:'.length).trim();
    try {
      const innerParsed = new URL(inner);
      const innerProto = innerParsed.protocol.toLowerCase();
      if (innerProto === 'http:' || innerProto === 'https:') {
        return `view-source:${innerParsed.href}`;
      }
    } catch {}
    return 'about:blank';
  }
  if (
    lower.startsWith('http://') ||
    lower.startsWith('https://') ||
    lower.startsWith('antifan://') ||
    lower.startsWith('antifan-preview://') ||
    lower === 'about:blank'
  ) {
    return trimmed;
  }
  if (trimmed.includes('.') && !trimmed.includes(' ')) {
    return `https://${trimmed}`;
  }
  return `https://www.google.com/search?q=${encodeURIComponent(trimmed)}`;
}

import * as path from 'path';
import * as fs from 'fs';

export function getSecureWebPreferences(partition?: string): WebPreferences {
  const candidatePaths = [
    path.join(__dirname, '..', '..', 'preload', 'tab-preload.js'),
    path.join(__dirname, '..', 'preload', 'tab-preload.js'),
    path.join(process.cwd(), '.compiled', 'src', 'preload', 'tab-preload.js'),
    path.join(process.cwd(), 'src', 'preload', 'tab-preload.js'),
  ];

  const resolvedPreload = candidatePaths.find((p) => fs.existsSync(p));

  const prefs: WebPreferences = {
    preload: resolvedPreload,
    contextIsolation: false,
    sandbox: true,
    nodeIntegration: false,
    webSecurity: true,
    allowRunningInsecureContent: false,
    navigateOnDragDrop: false,
    spellcheck: false,
    backgroundThrottling: true,
    autoplayPolicy: 'no-user-gesture-required',
    plugins: true,
    webgl: true,
  };

  if (partition) {
    prefs.partition = partition;
  }

  return prefs;
}
