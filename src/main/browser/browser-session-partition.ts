import { session, Session } from 'electron';
import { setupClientHintsOverride } from './google-auth-identity';
export type BrowserSessionUserAgentMode = 'clean' | 'native';

const configuredPartitions = new Set<string>();
const userAgentModeBySession = new WeakMap<Session, BrowserSessionUserAgentMode>();

/**
 * Deterministically derives an isolated Electron session partition name
 * from a validated capsuleId and userAgentMode.
 * Native mode partitions are suffixed with `-native` to ensure they never share
 * session cookies, state, or UA configurations with clean/standard storefront partitions.
 */
export function deriveCapsulePartition(
  capsuleId?: string,
  mode: BrowserSessionUserAgentMode = 'clean',
  ephemeral = false
): string {
  if (ephemeral) {
    const effectiveId = capsuleId && typeof capsuleId === 'string' && capsuleId.trim()
      ? capsuleId.trim()
      : 'default';
    const nonce = Math.random().toString(36).slice(2, 10);
    return mode === 'native'
      ? `ephemeral-${effectiveId}-${nonce}-native`
      : `ephemeral-${effectiveId}-${nonce}`;
  }
  const effectiveId = capsuleId && typeof capsuleId === 'string' && capsuleId.trim()
    ? capsuleId.trim()
    : 'default';
  return mode === 'native'
    ? `persist:capsule-${effectiveId}-native`
    : `persist:capsule-${effectiveId}`;
}

/**
 * Strips Electron and app branding tokens from a default user agent string,
 * leaving pure desktop Chromium tokens for Cloudflare Turnstile and storefront compatibility.
 */
export function cleanElectronUserAgent(userAgent: string): string {
  if (!userAgent || typeof userAgent !== 'string') return '';
  return userAgent
    .replace(/\s*Electron\/[^\s]+/g, '')
    .replace(/\s*AntiFan[^\s]*/g, '')
    .replace(/\s*antifan-browser[^\s]*/g, '')
    .replace(/\s{2,}/g, ' ')
    .trim();
}

/**
 * Stores the userAgentMode for a specific Electron Session instance.
 */
export function setBrowserSessionUserAgentMode(
  sess: Session,
  mode: BrowserSessionUserAgentMode
): void {
  if (!sess) return;
  userAgentModeBySession.set(sess, mode);
}

/**
 * Retrieves the configured userAgentMode for a session instance, defaulting to 'clean'.
 */
export function getBrowserSessionUserAgentMode(
  sess: Session
): BrowserSessionUserAgentMode {
  if (!sess) return 'clean';
  return userAgentModeBySession.get(sess) ?? 'clean';
}

/**
 * Configures an Electron session partition with deterministic policies before view construction.
 * In 'native' mode, authentic Chromium UA & Client Hints are preserved with zero header tampering.
 * In 'clean' mode, cleanElectronUserAgent is applied for Cloudflare / merchant storefront compatibility.
 */
export function configureBrowserSessionPartition(
  partition: string,
  mode: BrowserSessionUserAgentMode = 'clean'
): Session {
  const sess = partition ? session.fromPartition(partition) : session.defaultSession;
  setBrowserSessionUserAgentMode(sess, mode);

  if (partition && configuredPartitions.has(partition)) {
    return sess;
  }
  if (partition) {
    configuredPartitions.add(partition);
  }

  if (mode === 'native') {
    // In native mode, preserve 100% authentic Chromium runtime headers and UA.
    // Zero onBeforeSendHeaders interceptors are installed.
    return sess;
  }

  // In clean mode, strip Electron/App tokens and setup Chrome Client Hints + Google Auth override
  try {
    if (typeof sess.getUserAgent === 'function' && typeof sess.setUserAgent === 'function') {
      const currentUa = sess.getUserAgent();
      const cleaned = cleanElectronUserAgent(currentUa);
      if (cleaned && cleaned !== currentUa) {
        sess.setUserAgent(cleaned);
      }
      setupClientHintsOverride(sess, cleaned || currentUa);
    }
  } catch (err) {
    console.warn(`[browser-session-partition] Failed to configure UA & hints for partition ${partition}:`, err);
  }

  return sess;
}

/**
 * Resets tracked partition policies (useful for unit tests and partition deletion).
 */
export function clearBrowserSessionPartitionPolicies(partition?: string): void {
  if (partition) {
    configuredPartitions.delete(partition);
  } else {
    configuredPartitions.clear();
  }
}
