/**
 * AntiFan Browser Desktop — Security Policy
 * Enforces strict sandbox isolation, URL validation, and deny-by-default popup routing.
 */
import { WebPreferences, shell } from 'electron';

const ALLOWED_PROTOCOLS = new Set(['http:', 'https:', 'about:']);
const BLOCKED_SCHEMES = new Set(['file:', 'javascript:', 'vbscript:', 'data:', 'chrome:', 'devtools:']);

export function isAllowedNavigation(targetUrl: string): boolean {
  try {
    const parsed = new URL(targetUrl);
    if (BLOCKED_SCHEMES.has(parsed.protocol)) {
      return false;
    }
    return ALLOWED_PROTOCOLS.has(parsed.protocol);
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
  if (trimmed.startsWith('http://') || trimmed.startsWith('https://') || trimmed === 'about:blank') {
    return trimmed;
  }
  if (trimmed.includes('.') && !trimmed.includes(' ')) {
    return `https://${trimmed}`;
  }
  return `https://www.google.com/search?q=${encodeURIComponent(trimmed)}`;
}

import * as path from 'path';
import * as fs from 'fs';

export function getSecureWebPreferences(): WebPreferences {
  const candidatePaths = [
    path.join(__dirname, '..', '..', 'preload', 'tab-preload.js'),
    path.join(__dirname, '..', 'preload', 'tab-preload.js'),
    path.join(process.cwd(), '.compiled', 'src', 'preload', 'tab-preload.js'),
    path.join(process.cwd(), 'src', 'preload', 'tab-preload.js'),
  ];

  const resolvedPreload = candidatePaths.find((p) => fs.existsSync(p));

  return {
    preload: resolvedPreload,
    contextIsolation: true,
    sandbox: true,
    nodeIntegration: false,
    webSecurity: true,
    allowRunningInsecureContent: false,
    navigateOnDragDrop: false,
    spellcheck: false,
  };
}
